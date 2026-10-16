package sqliterepo

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenSharedCreatesOnlySharedTables(t *testing.T) {
	db, err := OpenShared(filepath.Join(t.TempDir(), "shared.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	assertSchemaVersion(t, db, sharedSchemaVersion)
	for _, table := range []string{
		"deployment_storage_identity",
		"runtime_writer_fence",
		"threads",
		"messages",
		"memory_meta",
		"memory_revisions",
	} {
		assertTableExists(t, db, table, true)
	}
	for _, table := range []string{"runs", "run_checkpoints", "tasks", "jobs", "job_locks"} {
		assertTableExists(t, db, table, false)
	}
}

func TestOpenExecutionCreatesOnlyExecutionTables(t *testing.T) {
	db, err := OpenExecution(filepath.Join(t.TempDir(), "execution.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	assertSchemaVersion(t, db, executionSchemaVersion)
	for _, table := range []string{
		"revision_execution_identity",
		"runs",
		"run_checkpoints",
		"tasks",
		"task_run_keys",
		"jobs",
		"job_locks",
	} {
		assertTableExists(t, db, table, true)
	}
	for _, table := range []string{"threads", "messages", "memory_meta", "memory_revisions"} {
		assertTableExists(t, db, table, false)
	}
}

func TestOpenManagedRejectsFutureSchemaVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.db")
	db, err := OpenShared(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := OpenShared(path, Options{}); err == nil {
		t.Fatal("OpenShared accepted a future schema version")
	}
}

func assertSchemaVersion(t *testing.T, db *sql.DB, expected int) {
	t.Helper()
	var actual int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if actual != expected {
		t.Fatalf("schema version = %d, want %d", actual, expected)
	}
}

func assertTableExists(t *testing.T, db *sql.DB, table string, expected bool) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		table,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if actual := count == 1; actual != expected {
		t.Fatalf("table %q exists = %t, want %t", table, actual, expected)
	}
}
