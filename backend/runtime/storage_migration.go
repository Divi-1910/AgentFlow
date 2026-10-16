package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"backend/fsatomic"
	"backend/repo/sqliterepo"
)

const managedLayoutVersion = 1

var runtimePrincipalPattern = regexp.MustCompile(`^runtime_[0-9a-f]{32}$`)

var legacySharedTables = []string{"memory_meta", "memory_revisions", "threads", "messages"}
var legacyExecutionTables = []string{"runs", "run_checkpoints", "tasks", "task_run_keys", "jobs", "job_locks"}

type storageMigrationRequest struct {
	DataDir       string
	StorageID     string
	DeploymentID  string
	ConfigHash    string
	SchemaVersion int
}

type storageMigrationPlan struct {
	LayoutVersion       int              `json:"layout_version"`
	StorageID           string           `json:"storage_id"`
	DeploymentID        string           `json:"deployment_id"`
	SourceConfigHash    string           `json:"source_config_hash"`
	BundleSchemaVersion int              `json:"bundle_schema_version"`
	RuntimePrincipalID  string           `json:"runtime_principal_id"`
	QuarantineDirectory string           `json:"quarantine_directory"`
	SourceTableRows     map[string]int64 `json:"source_table_rows"`
	MemoryFiles         int              `json:"memory_files"`
	ScratchpadFiles     int              `json:"scratchpad_files"`
	Completed           bool             `json:"completed"`
	RequiresOffline     bool             `json:"requires_offline"`
}

type storageMigrationManifest struct {
	Plan      storageMigrationPlan `json:"plan"`
	Phase     string               `json:"phase"`
	UpdatedAt time.Time            `json:"updated_at"`
}

func migrateLegacyStorage(ctx context.Context, request storageMigrationRequest, apply bool) (storageMigrationPlan, error) {
	paths, err := storageMigrationPaths(request)
	if err != nil {
		return storageMigrationPlan{}, err
	}
	if layout, err := readStorageMigrationPlan(paths.layout); err == nil {
		if layout.StorageID != request.StorageID || layout.DeploymentID != request.DeploymentID ||
			layout.SourceConfigHash != request.ConfigHash || layout.BundleSchemaVersion != request.SchemaVersion {
			return storageMigrationPlan{}, errors.New("storage migration: completed layout identity does not match request")
		}
		if err := verifyCompletedStorageMigration(ctx, paths, layout); err != nil {
			return storageMigrationPlan{}, err
		}
		layout.Completed = true
		return layout, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return storageMigrationPlan{}, err
	}

	if !apply {
		return inspectLegacyStorage(ctx, request, paths)
	}
	if err := os.MkdirAll(paths.metadata, 0o750); err != nil {
		return storageMigrationPlan{}, fmt.Errorf("storage migration: create metadata directory: %w", err)
	}
	lock, err := acquireManagedWriterLock(paths.metadata)
	if err != nil {
		return storageMigrationPlan{}, err
	}
	defer lock.Close()

	if manifest, err := readStorageMigrationManifest(paths.manifest); err == nil {
		if err := resumeStorageMigration(ctx, request, paths, &manifest); err != nil {
			return storageMigrationPlan{}, err
		}
		manifest.Plan.Completed = true
		return manifest.Plan, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return storageMigrationPlan{}, err
	}

	plan, err := inspectLegacyStorage(ctx, request, paths)
	if err != nil {
		return storageMigrationPlan{}, err
	}
	if err := os.RemoveAll(paths.staging); err != nil {
		return storageMigrationPlan{}, fmt.Errorf("storage migration: clear incomplete staging: %w", err)
	}
	if err := stageLegacyStorage(ctx, request, paths, plan); err != nil {
		return storageMigrationPlan{}, err
	}
	manifest := storageMigrationManifest{Plan: plan, Phase: "staged", UpdatedAt: time.Now().UTC()}
	if err := writeJSONAtomic(paths.manifest, manifest, 0o600); err != nil {
		return storageMigrationPlan{}, err
	}
	if err := resumeStorageMigration(ctx, request, paths, &manifest); err != nil {
		return storageMigrationPlan{}, err
	}
	manifest.Plan.Completed = true
	return manifest.Plan, nil
}

type migrationPaths struct {
	root, sourceDB, sourceMemory, sourceScratchpad string
	metadata, manifest, layout, staging            string
	shared, revisions, quarantine, legacy          string
}

func storageMigrationPaths(request storageMigrationRequest) (migrationPaths, error) {
	root := filepath.Clean(strings.TrimSpace(request.DataDir))
	if root == "." || !managedDigestRE.MatchString(request.StorageID) ||
		strings.TrimSpace(request.DeploymentID) == "" || !managedDigestRE.MatchString(request.ConfigHash) ||
		request.SchemaVersion <= 0 {
		return migrationPaths{}, errors.New("storage migration: data directory, storage/deployment identity, config hash, and schema version are required")
	}
	quarantineName := "legacy-v3-" + request.ConfigHash[:12]
	return migrationPaths{
		root: root, sourceDB: filepath.Join(root, "state.db"),
		sourceMemory: filepath.Join(root, "memory"), sourceScratchpad: filepath.Join(root, "scratchpad"),
		metadata: filepath.Join(root, "deployment-meta"),
		manifest: filepath.Join(root, "deployment-meta", "storage-migration.json"),
		layout:   filepath.Join(root, "deployment-meta", "layout.json"),
		staging:  filepath.Join(root, ".storage-migration-v1"),
		shared:   filepath.Join(root, "shared"), revisions: filepath.Join(root, "revisions"),
		quarantine: quarantineName, legacy: filepath.Join(root, "legacy"),
	}, nil
}

func inspectLegacyStorage(ctx context.Context, request storageMigrationRequest, paths migrationPaths) (storageMigrationPlan, error) {
	for _, target := range []string{paths.shared, paths.revisions} {
		if _, err := os.Lstat(target); err == nil {
			return storageMigrationPlan{}, fmt.Errorf("storage migration: target path already exists without completed layout: %s", target)
		} else if !errors.Is(err, os.ErrNotExist) {
			return storageMigrationPlan{}, err
		}
	}
	db, err := openLegacyStorageDB(paths.sourceDB)
	if err != nil {
		return storageMigrationPlan{}, err
	}
	defer db.Close()
	var userVersion int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&userVersion); err != nil || userVersion != 3 {
		return storageMigrationPlan{}, fmt.Errorf("storage migration: legacy SQLite user_version=%d, require 3: %w", userVersion, err)
	}
	if err := checkSQLiteIntegrity(ctx, db); err != nil {
		return storageMigrationPlan{}, err
	}
	var deploymentID, configHash, principal string
	if err := db.QueryRowContext(ctx, `SELECT deployment_id, config_hash, synthetic_user_id FROM deployment_identity WHERE singleton = 1`).Scan(&deploymentID, &configHash, &principal); err != nil {
		return storageMigrationPlan{}, fmt.Errorf("storage migration: read legacy identity: %w", err)
	}
	if deploymentID != request.DeploymentID || configHash != request.ConfigHash || !runtimePrincipalPattern.MatchString(principal) {
		return storageMigrationPlan{}, errors.New("storage migration: legacy identity does not match requested deployment/configuration")
	}
	counts := make(map[string]int64, len(legacySharedTables)+len(legacyExecutionTables))
	for _, table := range append(append([]string(nil), legacySharedTables...), legacyExecutionTables...) {
		var count int64
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
			return storageMigrationPlan{}, fmt.Errorf("storage migration: count legacy table %s: %w", table, err)
		}
		counts[table] = count
	}
	memoryFiles, err := inspectMigrationTree(paths.sourceMemory)
	if err != nil {
		return storageMigrationPlan{}, err
	}
	scratchpadFiles, err := inspectMigrationTree(paths.sourceScratchpad)
	if err != nil {
		return storageMigrationPlan{}, err
	}
	return storageMigrationPlan{
		LayoutVersion: managedLayoutVersion, StorageID: request.StorageID, DeploymentID: request.DeploymentID,
		SourceConfigHash: request.ConfigHash, BundleSchemaVersion: request.SchemaVersion, RuntimePrincipalID: principal,
		QuarantineDirectory: paths.quarantine, SourceTableRows: counts,
		MemoryFiles: memoryFiles, ScratchpadFiles: scratchpadFiles, RequiresOffline: true,
	}, nil
}

func openLegacyStorageDB(path string) (*sql.DB, error) {
	if info, err := os.Lstat(path); err != nil {
		return nil, fmt.Errorf("storage migration: legacy state.db is required: %w", err)
	} else if !info.Mode().IsRegular() {
		return nil, errors.New("storage migration: legacy state.db must be a regular file")
	}
	databaseURL := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := databaseURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "query_only(1)")
	databaseURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		return nil, fmt.Errorf("storage migration: open legacy database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("storage migration: ping legacy database: %w", err)
	}
	return db, nil
}

func inspectMigrationTree(root string) (int, error) {
	count := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) && path == root {
				return nil
			}
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("storage migration: symlink is not allowed: %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("storage migration: unsupported file type: %s", path)
		}
		count++
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	return count, err
}

func stageLegacyStorage(ctx context.Context, request storageMigrationRequest, paths migrationPaths, plan storageMigrationPlan) error {
	stageShared := filepath.Join(paths.staging, "shared")
	stageRevision := filepath.Join(paths.staging, "revisions", paths.quarantine)
	if err := os.MkdirAll(stageShared, 0o750); err != nil {
		return fmt.Errorf("storage migration: create shared staging directory: %w", err)
	}
	if err := os.MkdirAll(stageRevision, 0o750); err != nil {
		return fmt.Errorf("storage migration: create staging directories: %w", err)
	}
	sharedDB, err := sqliterepo.OpenShared(filepath.Join(stageShared, "shared.db"), sqliterepo.Options{})
	if err != nil {
		return fmt.Errorf("storage migration: create shared database: %w", err)
	}
	if err := copyLegacyTables(ctx, sharedDB, paths.sourceDB, legacySharedTables); err != nil {
		_ = sharedDB.Close()
		return err
	}
	if _, err := sqliterepo.NewStorageIdentityRepo(sharedDB).Bind(ctx, sqliterepo.StorageBinding{
		StorageID: request.StorageID, DeploymentID: request.DeploymentID, RuntimePrincipalID: plan.RuntimePrincipalID,
	}); err != nil {
		_ = sharedDB.Close()
		return err
	}
	if err := sharedDB.Close(); err != nil {
		return err
	}
	executionDB, err := sqliterepo.OpenExecution(filepath.Join(stageRevision, "execution.db"), sqliterepo.Options{})
	if err != nil {
		return fmt.Errorf("storage migration: create quarantine database: %w", err)
	}
	if err := copyLegacyTables(ctx, executionDB, paths.sourceDB, legacyExecutionTables); err != nil {
		_ = executionDB.Close()
		return err
	}
	if err := executionDB.Close(); err != nil {
		return err
	}
	if err := copyMigrationTree(paths.sourceMemory, filepath.Join(stageShared, "memory")); err != nil {
		return err
	}
	if err := copyMigrationTree(paths.sourceScratchpad, filepath.Join(stageRevision, "scratchpad")); err != nil {
		return err
	}
	return verifyStagedStorageMigration(ctx, paths.staging, plan)
}

func copyLegacyTables(ctx context.Context, target *sql.DB, sourcePath string, tables []string) error {
	if _, err := target.ExecContext(ctx, "ATTACH DATABASE ? AS legacy", sourcePath); err != nil {
		return fmt.Errorf("storage migration: attach legacy database: %w", err)
	}
	defer target.ExecContext(context.Background(), "DETACH DATABASE legacy")
	tx, err := target.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range tables {
		if _, err := tx.ExecContext(ctx, "INSERT INTO main."+table+" SELECT * FROM legacy."+table); err != nil {
			return fmt.Errorf("storage migration: copy table %s: %w", table, err)
		}
	}
	return tx.Commit()
}

func copyMigrationTree(source, target string) error {
	if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
		return os.MkdirAll(target, 0o750)
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			return errors.New("storage migration: source path escaped root")
		}
		destination := filepath.Join(target, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("storage migration: symlink is not allowed: %s", path)
		}
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o750)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("storage migration: unsupported file type: %s", path)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		closeErr := errors.Join(input.Close(), output.Sync(), output.Close())
		return errors.Join(copyErr, closeErr)
	})
}

func resumeStorageMigration(ctx context.Context, request storageMigrationRequest, paths migrationPaths, manifest *storageMigrationManifest) error {
	if manifest.Plan.StorageID != request.StorageID || manifest.Plan.DeploymentID != request.DeploymentID ||
		manifest.Plan.SourceConfigHash != request.ConfigHash || manifest.Plan.BundleSchemaVersion != request.SchemaVersion {
		return errors.New("storage migration: in-progress manifest identity does not match request")
	}
	if manifest.Phase == "staged" {
		if err := installMigrationDirectory(filepath.Join(paths.staging, "shared"), paths.shared); err != nil {
			return err
		}
		if err := installMigrationDirectory(filepath.Join(paths.staging, "revisions"), paths.revisions); err != nil {
			return err
		}
		manifest.Phase = "installed"
		manifest.UpdatedAt = time.Now().UTC()
		if err := writeJSONAtomic(paths.manifest, manifest, 0o600); err != nil {
			return err
		}
	}
	if manifest.Phase == "installed" {
		if err := verifyInstalledStorageMigration(ctx, paths, manifest.Plan); err != nil {
			return err
		}
		if err := archiveLegacyStorage(paths); err != nil {
			return err
		}
		completed := manifest.Plan
		completed.Completed = true
		if err := writeJSONAtomic(paths.layout, completed, 0o600); err != nil {
			return err
		}
		manifest.Plan = completed
		manifest.Phase = "complete"
		manifest.UpdatedAt = time.Now().UTC()
		if err := writeJSONAtomic(paths.manifest, manifest, 0o600); err != nil {
			return err
		}
		_ = os.RemoveAll(paths.staging)
	}
	if manifest.Phase != "complete" {
		return fmt.Errorf("storage migration: unsupported manifest phase %q", manifest.Phase)
	}
	return verifyCompletedStorageMigration(ctx, paths, manifest.Plan)
}

func installMigrationDirectory(source, target string) error {
	if _, err := os.Lstat(target); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(source, target); err != nil {
		return fmt.Errorf("storage migration: install %s: %w", filepath.Base(target), err)
	}
	return nil
}

func archiveLegacyStorage(paths migrationPaths) error {
	if err := os.MkdirAll(paths.legacy, 0o750); err != nil {
		return err
	}
	moves := [][2]string{
		{paths.sourceDB, filepath.Join(paths.legacy, "combined-v3-state.db")},
		{paths.sourceDB + "-wal", filepath.Join(paths.legacy, "combined-v3-state.db-wal")},
		{paths.sourceDB + "-shm", filepath.Join(paths.legacy, "combined-v3-state.db-shm")},
		{paths.sourceMemory, filepath.Join(paths.legacy, "memory")},
		{paths.sourceScratchpad, filepath.Join(paths.legacy, "scratchpad")},
	}
	for _, move := range moves {
		if err := moveMigrationSource(move[0], move[1]); err != nil {
			return err
		}
	}
	return nil
}

func moveMigrationSource(source, target string) error {
	_, sourceErr := os.Lstat(source)
	_, targetErr := os.Lstat(target)
	switch {
	case errors.Is(sourceErr, os.ErrNotExist) && targetErr == nil:
		return nil
	case errors.Is(sourceErr, os.ErrNotExist) && errors.Is(targetErr, os.ErrNotExist):
		return nil
	case sourceErr != nil:
		return sourceErr
	case targetErr == nil:
		return fmt.Errorf("storage migration: both source and backup exist: %s", source)
	case !errors.Is(targetErr, os.ErrNotExist):
		return targetErr
	default:
		if err := os.Rename(source, target); err != nil {
			return fmt.Errorf("storage migration: archive %s: %w", source, err)
		}
		return nil
	}
}

func verifyStagedStorageMigration(ctx context.Context, staging string, plan storageMigrationPlan) error {
	return verifyMigrationTargets(ctx,
		filepath.Join(staging, "shared", "shared.db"),
		filepath.Join(staging, "revisions", plan.QuarantineDirectory, "execution.db"),
		filepath.Join(staging, "shared", "memory"),
		filepath.Join(staging, "revisions", plan.QuarantineDirectory, "scratchpad"),
		plan,
	)
}

func verifyInstalledStorageMigration(ctx context.Context, paths migrationPaths, plan storageMigrationPlan) error {
	return verifyMigrationTargets(ctx,
		filepath.Join(paths.shared, "shared.db"),
		filepath.Join(paths.revisions, plan.QuarantineDirectory, "execution.db"),
		filepath.Join(paths.shared, "memory"),
		filepath.Join(paths.revisions, plan.QuarantineDirectory, "scratchpad"),
		plan,
	)
}

func verifyCompletedStorageMigration(ctx context.Context, paths migrationPaths, plan storageMigrationPlan) error {
	if plan.LayoutVersion != managedLayoutVersion || !plan.Completed {
		return errors.New("storage migration: completed layout marker is invalid")
	}
	if err := verifyInstalledStorageMigration(ctx, paths, plan); err != nil {
		return err
	}
	if _, err := os.Lstat(paths.sourceDB); !errors.Is(err, os.ErrNotExist) {
		return errors.New("storage migration: active legacy state.db still exists")
	}
	return nil
}

func verifyMigrationTargets(ctx context.Context, sharedPath, executionPath, memoryPath, scratchpadPath string, plan storageMigrationPlan) error {
	for path, tables := range map[string][]string{sharedPath: legacySharedTables, executionPath: legacyExecutionTables} {
		db, err := openLegacyStorageDB(path)
		if err != nil {
			return err
		}
		if err := checkSQLiteIntegrity(ctx, db); err != nil {
			_ = db.Close()
			return err
		}
		for _, table := range tables {
			var count int64
			if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil || count != plan.SourceTableRows[table] {
				_ = db.Close()
				return fmt.Errorf("storage migration: table %s count=%d want=%d: %w", table, count, plan.SourceTableRows[table], err)
			}
		}
		if err := db.Close(); err != nil {
			return err
		}
	}
	sharedDB, err := openLegacyStorageDB(sharedPath)
	if err != nil {
		return err
	}
	var storageID, deploymentID, principal string
	identityErr := sharedDB.QueryRowContext(ctx, `SELECT storage_id, deployment_id, runtime_principal_id FROM deployment_storage_identity WHERE singleton = 1`).Scan(&storageID, &deploymentID, &principal)
	if identityErr != nil || storageID != plan.StorageID || deploymentID != plan.DeploymentID || principal != plan.RuntimePrincipalID {
		_ = sharedDB.Close()
		return fmt.Errorf("storage migration: shared identity verification failed: %w", identityErr)
	}
	if err := verifyMigratedMemoryFiles(ctx, sharedDB, memoryPath); err != nil {
		_ = sharedDB.Close()
		return err
	}
	if err := sharedDB.Close(); err != nil {
		return err
	}
	memoryFiles, err := inspectMigrationTree(memoryPath)
	if err != nil || memoryFiles != plan.MemoryFiles {
		return fmt.Errorf("storage migration: memory file count=%d want=%d: %w", memoryFiles, plan.MemoryFiles, err)
	}
	scratchpadFiles, err := inspectMigrationTree(scratchpadPath)
	if err != nil || scratchpadFiles != plan.ScratchpadFiles {
		return fmt.Errorf("storage migration: scratchpad file count=%d want=%d: %w", scratchpadFiles, plan.ScratchpadFiles, err)
	}
	return nil
}

func verifyMigratedMemoryFiles(ctx context.Context, db *sql.DB, memoryRoot string) error {
	rows, err := db.QueryContext(ctx, `SELECT body_path FROM memory_meta UNION SELECT body_path FROM memory_revisions`)
	if err != nil {
		return fmt.Errorf("storage migration: read memory body paths: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var stored string
		if err := rows.Scan(&stored); err != nil {
			return err
		}
		clean := filepath.Clean(stored)
		if stored == "" || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("storage migration: invalid memory body path %q", stored)
		}
		info, err := os.Lstat(filepath.Join(memoryRoot, clean))
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("storage migration: memory body %q is missing or not regular: %w", stored, err)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return nil
}

func checkSQLiteIntegrity(ctx context.Context, db *sql.DB) error {
	var result string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); err != nil {
		return fmt.Errorf("storage migration: SQLite integrity check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("storage migration: SQLite integrity check returned %q", result)
	}
	return nil
}

func readStorageMigrationPlan(path string) (storageMigrationPlan, error) {
	var plan storageMigrationPlan
	err := readJSONFile(path, &plan)
	return plan, err
}

func readStorageMigrationManifest(path string) (storageMigrationManifest, error) {
	var manifest storageMigrationManifest
	err := readJSONFile(path, &manifest)
	return manifest, err
}

func readJSONFile(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, value); err != nil {
		return fmt.Errorf("storage migration: decode %s: %w", path, err)
	}
	return nil
}

func writeJSONAtomic(path string, value any, _ os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := fsatomic.WriteFileAtomic(path, string(data)); err != nil {
		return fmt.Errorf("storage migration: write %s: %w", path, err)
	}
	return nil
}
