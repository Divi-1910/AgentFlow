package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"backend/repo/sqliterepo"
)

func TestManagedStorageContextValidate(t *testing.T) {
	bundle := runtimeTestBundle(t)
	valid := managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         11,
		expectedConfigHash: bundle.ConfigHash,
	}
	tests := []struct {
		name   string
		mutate func(*managedStorageContext)
	}{
		{name: "valid", mutate: func(*managedStorageContext) {}},
		{name: "invalid storage id", mutate: func(c *managedStorageContext) { c.storageID = "bad" }},
		{name: "wrong deployment", mutate: func(c *managedStorageContext) { c.deploymentID = "other" }},
		{name: "missing revision", mutate: func(c *managedStorageContext) { c.revision = 0 }},
		{name: "missing generation", mutate: func(c *managedStorageContext) { c.generation = 0 }},
		{name: "wrong config hash", mutate: func(c *managedStorageContext) { c.expectedConfigHash = strings.Repeat("b", 64) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			err := candidate.validate(bundle)
			if test.name == "valid" && err != nil {
				t.Fatalf("validate returned %v", err)
			}
			if test.name != "valid" && err == nil {
				t.Fatal("validate accepted invalid managed context")
			}
		})
	}
}

func TestNewManagedStoragePathsUsesOnlyNumericRevision(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	paths, err := newManagedStoragePaths(root, 42)
	if err != nil {
		t.Fatal(err)
	}
	if paths.sharedDB != filepath.Join(root, "shared", "shared.db") {
		t.Fatalf("shared db = %q", paths.sharedDB)
	}
	if paths.writerLock != filepath.Join(root, "deployment-meta", "writer.lock") {
		t.Fatalf("writer lock = %q", paths.writerLock)
	}
	if paths.executionDB != filepath.Join(root, "revisions", "r-0000000042", "execution.db") {
		t.Fatalf("execution db = %q", paths.executionDB)
	}
	if paths.memoryRoot != filepath.Join(root, "shared", "memory") {
		t.Fatalf("memory root = %q", paths.memoryRoot)
	}
	if paths.scratchpadRoot != filepath.Join(root, "revisions", "r-0000000042", "scratchpad") {
		t.Fatalf("scratchpad root = %q", paths.scratchpadRoot)
	}
	if _, err := newManagedStoragePaths(root, 0); err == nil {
		t.Fatal("newManagedStoragePaths accepted revision zero")
	}
}

func TestOpenManagedStorageSplitsRepositoriesAndPreservesPrincipal(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "managed")
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         1,
		expectedConfigHash: bundle.ConfigHash,
	}
	storage, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	firstPrincipal := storage.runtimePrincipalID
	if storage.sharedDB == storage.executionDB {
		t.Fatal("managed storage used one database for shared and execution data")
	}
	if !storage.isManaged {
		t.Fatal("managed storage was not marked managed")
	}
	if err := storage.sharedDB.QueryRow(`SELECT count(*) FROM threads`).Scan(new(int)); err != nil {
		t.Fatalf("shared threads table: %v", err)
	}
	if err := storage.executionDB.QueryRow(`SELECT count(*) FROM runs`).Scan(new(int)); err != nil {
		t.Fatalf("execution runs table: %v", err)
	}
	if err := storage.close(context.Background()); err != nil {
		t.Fatal(err)
	}

	reopened, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.close(context.Background()) })
	if reopened.runtimePrincipalID != firstPrincipal {
		t.Fatalf("principal after reopen = %q, want %q", reopened.runtimePrincipalID, firstPrincipal)
	}
}

func TestOpenManagedStorageRepeatedHashUsesNewExecutionStore(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "managed")
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         1,
		expectedConfigHash: bundle.ConfigHash,
	}
	revision7, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := revision7.executionDB.Exec(`
INSERT INTO runs(run_id, thread_id, agent_id, user_id, status, created_at, updated_at)
VALUES('old-run', 'thread', 'agent', 'user', 'interrupted', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	principalID := revision7.runtimePrincipalID
	if err := revision7.close(context.Background()); err != nil {
		t.Fatal(err)
	}

	managed.revision = 8
	managed.generation = 2
	revision8, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = revision8.close(context.Background()) })
	if revision8.runtimePrincipalID != principalID {
		t.Fatalf("runtime principal = %q, want %q", revision8.runtimePrincipalID, principalID)
	}
	var runs int
	if err := revision8.executionDB.QueryRow(`SELECT count(*) FROM runs`).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 0 {
		t.Fatalf("revision 8 adopted %d runs from revision 7 with the same hash", runs)
	}
}

func TestOpenManagedStorageRejectsLegacyLayout(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "legacy")
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "state.db"), []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         1,
		expectedConfigHash: bundle.ConfigHash,
	}
	_, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if !errors.Is(err, errManagedStorageMigrationRequired) {
		t.Fatalf("openManagedStorage error = %v, want migration required", err)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "shared")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("managed shared directory was created after legacy detection: %v", statErr)
	}
}

func TestOpenManagedStorageRejectsConcurrentWriter(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "managed")
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         11,
		expectedConfigHash: bundle.ConfigHash,
	}
	first, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := openManagedStorage(context.Background(), dataDir, bundle, managed); !errors.Is(err, errManagedStorageLocked) {
		t.Fatalf("second managed writer error = %v, want errManagedStorageLocked", err)
	}
	if err := first.close(context.Background()); err != nil {
		t.Fatal(err)
	}

	reopened, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatalf("managed writer did not reopen after close: %v", err)
	}
	t.Cleanup(func() { _ = reopened.close(context.Background()) })
}

func TestOpenManagedStorageRejectsStaleGenerationAfterNewerWriterExits(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "managed")
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         11,
		expectedConfigHash: bundle.ConfigHash,
	}
	first, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.close(context.Background()); err != nil {
		t.Fatal(err)
	}

	managed.revision = 8
	managed.generation = 12
	newer, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	if err := newer.close(context.Background()); err != nil {
		t.Fatal(err)
	}

	managed.revision = 7
	managed.generation = 11
	if _, err := openManagedStorage(context.Background(), dataDir, bundle, managed); !errors.Is(err, sqliterepo.ErrWriterGenerationStale) {
		t.Fatalf("stale managed writer error = %v, want ErrWriterGenerationStale", err)
	}

	managed.revision = 8
	managed.generation = 12
	restarted, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatalf("newest generation could not restart after stale rejection: %v", err)
	}
	t.Cleanup(func() { _ = restarted.close(context.Background()) })
}

func TestOpenManagedStorageRejectsGenerationIdentityConflict(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "managed")
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         11,
		expectedConfigHash: bundle.ConfigHash,
	}
	first, err := openManagedStorage(context.Background(), dataDir, bundle, managed)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.close(context.Background()); err != nil {
		t.Fatal(err)
	}

	managed.revision = 8
	if _, err := openManagedStorage(context.Background(), dataDir, bundle, managed); !errors.Is(err, sqliterepo.ErrWriterGenerationConflict) {
		t.Fatalf("conflicting managed writer error = %v, want ErrWriterGenerationConflict", err)
	}
}

func TestOpenManagedStorageReleasesLockWhenDatabaseOpenFails(t *testing.T) {
	bundle := runtimeTestBundle(t)
	dataDir := filepath.Join(t.TempDir(), "managed")
	if err := os.MkdirAll(filepath.Join(dataDir, "shared", "shared.db"), 0o750); err != nil {
		t.Fatal(err)
	}
	managed := &managedStorageContext{
		storageID:          strings.Repeat("a", 64),
		deploymentID:       bundle.DeploymentID,
		revision:           7,
		generation:         11,
		expectedConfigHash: bundle.ConfigHash,
	}
	if _, err := openManagedStorage(context.Background(), dataDir, bundle, managed); err == nil {
		t.Fatal("openManagedStorage succeeded with a directory at the shared database path")
	}

	lock, err := acquireManagedWriterLock(filepath.Join(dataDir, "deployment-meta"))
	if err != nil {
		t.Fatalf("writer lock remained held after failed startup: %v", err)
	}
	t.Cleanup(func() { _ = lock.Close() })
}
