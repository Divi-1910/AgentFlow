package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"backend/deployment"
	"backend/repo/sqliterepo"
)

var (
	errManagedStorageMigrationRequired = errors.New("runtime: managed storage migration required")
	managedDigestRE                    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type managedStorageContext struct {
	storageID          string
	deploymentID       string
	revision           int
	generation         int64
	expectedConfigHash string
}

func (c *managedStorageContext) validate(bundle *deployment.Bundle) error {
	if c == nil {
		return nil
	}
	if bundle == nil {
		return fmt.Errorf("runtime: deployment bundle is required")
	}
	if !managedDigestRE.MatchString(c.storageID) {
		return fmt.Errorf("runtime: managed storage id must be a lowercase sha256 digest")
	}
	if strings.TrimSpace(c.deploymentID) == "" {
		return fmt.Errorf("runtime: managed deployment id is required")
	}
	if c.revision <= 0 || c.generation <= 0 {
		return fmt.Errorf("runtime: managed revision and generation must be positive")
	}
	if !managedDigestRE.MatchString(c.expectedConfigHash) {
		return fmt.Errorf("runtime: expected config hash must be a lowercase sha256 digest")
	}
	if c.deploymentID != bundle.DeploymentID {
		return fmt.Errorf(
			"runtime: managed deployment id %q does not match bundle deployment id %q",
			c.deploymentID,
			bundle.DeploymentID,
		)
	}
	if c.expectedConfigHash != bundle.ConfigHash {
		return fmt.Errorf("runtime: managed config hash does not match verified bundle hash")
	}
	return nil
}

type managedStoragePaths struct {
	metadataDir    string
	writerLock     string
	sharedDir      string
	sharedDB       string
	revisionDir    string
	executionDB    string
	memoryRoot     string
	scratchpadRoot string
}

func newManagedStoragePaths(dataDir string, revision int) (managedStoragePaths, error) {
	if strings.TrimSpace(dataDir) == "" {
		return managedStoragePaths{}, fmt.Errorf("runtime: data directory is required")
	}
	if revision <= 0 {
		return managedStoragePaths{}, fmt.Errorf("runtime: managed revision must be positive")
	}
	root := filepath.Clean(dataDir)
	revisionName := "r-" + fmt.Sprintf("%010d", revision)
	sharedDir := filepath.Join(root, "shared")
	revisionDir := filepath.Join(root, "revisions", revisionName)
	return managedStoragePaths{
		metadataDir:    filepath.Join(root, "deployment-meta"),
		writerLock:     filepath.Join(root, "deployment-meta", "writer.lock"),
		sharedDir:      sharedDir,
		sharedDB:       filepath.Join(sharedDir, "shared.db"),
		revisionDir:    revisionDir,
		executionDB:    filepath.Join(revisionDir, "execution.db"),
		memoryRoot:     filepath.Join(sharedDir, "memory"),
		scratchpadRoot: filepath.Join(revisionDir, "scratchpad"),
	}, nil
}

type runtimeStorage struct {
	sharedDB           *sql.DB
	executionDB        *sql.DB
	writerLock         *managedWriterLock
	writerFence        *sqliterepo.WriterFenceRepo
	writerClaim        *sqliterepo.WriterFenceClaim
	runtimePrincipalID string
	memoryRoot         string
	scratchpadRoot     string
	isManaged          bool
}

func openRuntimeStorage(
	ctx context.Context,
	dataDir string,
	bundle *deployment.Bundle,
	managed *managedStorageContext,
) (*runtimeStorage, error) {
	if managed == nil {
		return openStandaloneStorage(ctx, dataDir, bundle)
	}
	return openManagedStorage(ctx, dataDir, bundle, managed)
}

func openStandaloneStorage(
	ctx context.Context,
	dataDir string,
	bundle *deployment.Bundle,
) (*runtimeStorage, error) {
	db, err := sqliterepo.Open(filepath.Join(dataDir, "state.db"), sqliterepo.Options{})
	if err != nil {
		return nil, err
	}
	principalID := bundle.SyntheticUserID()
	identityRepo := sqliterepo.NewDeploymentIdentityRepo(db)
	err = identityRepo.Bind(ctx, sqliterepo.DeploymentBinding{
		DeploymentID:    bundle.DeploymentID,
		ConfigHash:      bundle.ConfigHash,
		SyntheticUserID: principalID,
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &runtimeStorage{
		sharedDB:           db,
		executionDB:        db,
		runtimePrincipalID: principalID,
		memoryRoot:         filepath.Join(dataDir, "memory"),
		scratchpadRoot:     filepath.Join(dataDir, "scratchpad"),
	}, nil
}

func openManagedStorage(
	ctx context.Context,
	dataDir string,
	bundle *deployment.Bundle,
	managed *managedStorageContext,
) (*runtimeStorage, error) {
	paths, err := newManagedStoragePaths(dataDir, managed.revision)
	if err != nil {
		return nil, err
	}
	if err := rejectLegacyManagedLayout(dataDir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(paths.metadataDir, 0o750); err != nil {
		return nil, fmt.Errorf("runtime: create managed metadata directory: %w", err)
	}
	writerLock, err := acquireManagedWriterLock(paths.metadataDir)
	if err != nil {
		return nil, err
	}
	storage := &runtimeStorage{writerLock: writerLock, isManaged: true}
	success := false
	defer func() {
		if !success {
			_ = storage.close(context.Background())
		}
	}()

	for _, dir := range []string{paths.sharedDir, paths.revisionDir} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("runtime: create managed storage directory: %w", err)
		}
	}

	sharedDB, err := sqliterepo.OpenShared(paths.sharedDB, sqliterepo.Options{})
	if err != nil {
		return nil, fmt.Errorf("runtime: open shared database: %w", err)
	}
	storage.sharedDB = sharedDB

	candidatePrincipal, err := newRuntimePrincipalID()
	if err != nil {
		return nil, err
	}
	storageBinding, err := sqliterepo.NewStorageIdentityRepo(sharedDB).Bind(ctx, sqliterepo.StorageBinding{
		StorageID:          managed.storageID,
		DeploymentID:       managed.deploymentID,
		RuntimePrincipalID: candidatePrincipal,
	})
	if err != nil {
		return nil, err
	}
	runtimeInstanceID, err := newRuntimeInstanceID()
	if err != nil {
		return nil, err
	}
	writerFence := sqliterepo.NewWriterFenceRepo(sharedDB)
	writerClaim := sqliterepo.WriterFenceClaim{
		Generation:        managed.generation,
		Revision:          managed.revision,
		ConfigHash:        managed.expectedConfigHash,
		RuntimeInstanceID: runtimeInstanceID,
	}
	if err := writerFence.Claim(ctx, writerClaim); err != nil {
		return nil, err
	}
	storage.writerFence = writerFence
	storage.writerClaim = &writerClaim

	executionDB, err := sqliterepo.OpenExecution(paths.executionDB, sqliterepo.Options{})
	if err != nil {
		return nil, fmt.Errorf("runtime: open revision execution database: %w", err)
	}
	storage.executionDB = executionDB

	err = sqliterepo.NewExecutionIdentityRepo(executionDB).Bind(ctx, sqliterepo.ExecutionBinding{
		StorageID:           managed.storageID,
		DeploymentID:        managed.deploymentID,
		Revision:            managed.revision,
		ConfigHash:          managed.expectedConfigHash,
		BundleSchemaVersion: bundle.SchemaVersion,
	})
	if err != nil {
		return nil, err
	}

	storage.runtimePrincipalID = storageBinding.RuntimePrincipalID
	storage.memoryRoot = paths.memoryRoot
	storage.scratchpadRoot = paths.scratchpadRoot
	success = true
	return storage, nil
}

func rejectLegacyManagedLayout(dataDir string) error {
	legacyPaths := []string{
		filepath.Join(dataDir, "state.db"),
		filepath.Join(dataDir, "state.db-wal"),
		filepath.Join(dataDir, "state.db-shm"),
		filepath.Join(dataDir, "memory"),
		filepath.Join(dataDir, "scratchpad"),
	}
	for _, path := range legacyPaths {
		_, err := os.Lstat(path)
		switch {
		case err == nil:
			return fmt.Errorf("%w: legacy path %q exists", errManagedStorageMigrationRequired, path)
		case errors.Is(err, os.ErrNotExist):
			continue
		default:
			return fmt.Errorf("runtime: inspect managed storage path %q: %w", path, err)
		}
	}
	return nil
}

func newRuntimePrincipalID() (string, error) {
	return newRandomRuntimeID("runtime_", "runtime principal")
}

func newRuntimeInstanceID() (string, error) {
	return newRandomRuntimeID("instance_", "runtime instance")
}

func newRandomRuntimeID(prefix, label string) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("runtime: generate %s id: %w", label, err)
	}
	return prefix + hex.EncodeToString(random), nil
}

func (s *runtimeStorage) close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	var closeErr error
	if s.executionDB != nil && s.executionDB != s.sharedDB {
		closeErr = errors.Join(closeErr, s.executionDB.Close())
	}
	if s.writerFence != nil && s.writerClaim != nil && s.sharedDB != nil {
		released, err := s.writerFence.Release(ctx, *s.writerClaim)
		if err == nil && !released {
			err = fmt.Errorf("runtime: managed writer fence ownership was lost before shutdown")
		}
		closeErr = errors.Join(closeErr, err)
	}
	if s.sharedDB != nil {
		closeErr = errors.Join(closeErr, s.sharedDB.Close())
	}
	if s.writerLock != nil {
		closeErr = errors.Join(closeErr, s.writerLock.Close())
	}
	return closeErr
}

func (s *runtimeStorage) ping(ctx context.Context) error {
	if err := s.sharedDB.PingContext(ctx); err != nil {
		return fmt.Errorf("runtime: ping shared database: %w", err)
	}
	if s.executionDB == s.sharedDB {
		return nil
	}
	if err := s.executionDB.PingContext(ctx); err != nil {
		return fmt.Errorf("runtime: ping execution database: %w", err)
	}
	return nil
}
