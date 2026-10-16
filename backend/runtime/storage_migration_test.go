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

func TestLegacyStorageMigrationDryRunApplyVerifyAndReplay(t *testing.T) {
	request := createLegacyStorageFixture(t)
	ctx := context.Background()

	plan, err := migrateLegacyStorage(ctx, request, false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Completed || !plan.RequiresOffline || plan.SourceTableRows["threads"] != 1 ||
		plan.SourceTableRows["runs"] != 1 || plan.MemoryFiles != 1 || plan.ScratchpadFiles != 1 {
		t.Fatalf("dry-run plan = %+v", plan)
	}
	for _, path := range []string{"shared", "revisions", "deployment-meta"} {
		if _, err := os.Lstat(filepath.Join(request.DataDir, path)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("dry run created %s: %v", path, err)
		}
	}

	applied, err := migrateLegacyStorage(ctx, request, true)
	if err != nil {
		t.Fatal(err)
	}
	if !applied.Completed || applied.RuntimePrincipalID != "runtime_"+strings.Repeat("c", 32) {
		t.Fatalf("applied plan = %+v", applied)
	}
	if err := rejectLegacyManagedLayout(request.DataDir); err != nil {
		t.Fatalf("completed layout still looks legacy: %v", err)
	}
	for _, path := range []string{
		filepath.Join(request.DataDir, "legacy", "combined-v3-state.db"),
		filepath.Join(request.DataDir, "legacy", "memory", "note.md"),
		filepath.Join(request.DataDir, "legacy", "scratchpad", "work.md"),
		filepath.Join(request.DataDir, "shared", "memory", "note.md"),
		filepath.Join(request.DataDir, "revisions", applied.QuarantineDirectory, "scratchpad", "work.md"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected migrated/backup path %s: %v", path, err)
		}
	}
	assertSQLiteCount(t, filepath.Join(request.DataDir, "shared", "shared.db"), "threads", 1)
	assertSQLiteCount(t, filepath.Join(request.DataDir, "revisions", applied.QuarantineDirectory, "execution.db"), "runs", 1)

	replayed, err := migrateLegacyStorage(ctx, request, true)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.Completed || replayed.QuarantineDirectory != applied.QuarantineDirectory {
		t.Fatalf("replayed plan = %+v", replayed)
	}
}

func TestLegacyStorageMigrationRejectsIdentityMismatchWithoutWriting(t *testing.T) {
	request := createLegacyStorageFixture(t)
	request.ConfigHash = strings.Repeat("d", 64)
	_, err := migrateLegacyStorage(context.Background(), request, false)
	if err == nil || !strings.Contains(err.Error(), "identity does not match") {
		t.Fatalf("identity mismatch error = %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(request.DataDir, "deployment-meta")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed dry run wrote metadata: %v", statErr)
	}
}

func createLegacyStorageFixture(t *testing.T) storageMigrationRequest {
	t.Helper()
	root := t.TempDir()
	configHash := strings.Repeat("a", 64)
	db, err := sqliterepo.Open(filepath.Join(root, "state.db"), sqliterepo.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := sqliterepo.NewDeploymentIdentityRepo(db).Bind(context.Background(), sqliterepo.DeploymentBinding{
		DeploymentID: "deployment-1", ConfigHash: configHash,
		SyntheticUserID: "runtime_" + strings.Repeat("c", 32),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO threads(id,user_id,agent_id,kind,originator_run_id,title,summary,created_at,updated_at) VALUES('thread-1','runtime','agent','','','title','',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO runs(run_id,thread_id,agent_id,user_id,status,created_at,updated_at) VALUES('run-1','thread-1','agent','runtime','completed',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO memory_meta(lineage_key,user_id,agent_id,thread_id,memory_id,scope,type,importance,revision,body_path,created_at,updated_at) VALUES('lineage','runtime','agent','','memory','agent','note',1,1,'note.md',1,1)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(root, "memory", "note.md"):     "durable memory",
		filepath.Join(root, "scratchpad", "work.md"): "revision work",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return storageMigrationRequest{
		DataDir: root, StorageID: strings.Repeat("b", 64), DeploymentID: "deployment-1",
		ConfigHash: configHash, SchemaVersion: 1,
	}
}

func assertSQLiteCount(t *testing.T, path, table string, want int64) {
	t.Helper()
	db, err := openLegacyStorageDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var got int64
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("%s count = %d, want %d", table, got, want)
	}
}
