package sqliterepo

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	backenddb "backend/db"
)

func TestOpenMigratesVersionZeroAndIsIdempotent(t *testing.T) {
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("user_version: %v", err)
	}
	if version != schemaVersion {
		t.Fatalf("user_version = %d, want %d", version, schemaVersion)
	}
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("idempotent Migrate: %v", err)
	}
	var table string
	if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='runs'`).Scan(&table); err != nil {
		t.Fatalf("runs table: %v", err)
	}
}

func TestMigrationRollsBackSchemaAndVersionOnFailure(t *testing.T) {
	db, err := backenddb.OpenSQLite(":memory:", backenddb.SQLiteOptions{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()
	err = migrate(context.Background(), db, []string{`CREATE TABLE rolled_back(id INTEGER); INVALID SQL;`})
	if err == nil {
		t.Fatal("migrate unexpectedly succeeded")
	}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 0 {
		t.Fatalf("user_version = %d, err=%v; want 0", version, err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='rolled_back'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled_back table count = %d, err=%v; want 0", count, err)
	}
}

func TestMigrateRejectsFutureVersion(t *testing.T) {
	db, err := backenddb.OpenSQLite(":memory:", backenddb.SQLiteOptions{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec("PRAGMA user_version = 99"); err != nil {
		t.Fatalf("set user_version: %v", err)
	}
	if err := Migrate(context.Background(), db); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("Migrate future version error = %v", err)
	}
}

func TestOpenEffectivePragmasAndPool(t *testing.T) {
	tests := []struct {
		name, path, journal string
		opts                Options
		busy                int
	}{
		{name: "memory", path: ":memory:", journal: "MEMORY", opts: Options{JournalMode: "MEMORY", BusyTimeout: 37 * time.Millisecond}, busy: 37},
		{name: "file_defaults", path: t.TempDir() + "/state.db", journal: "WAL", opts: Options{}, busy: 5000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db, err := Open(tt.path, tt.opts)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer db.Close()
			if got := db.Stats().MaxOpenConnections; got != 1 {
				t.Fatalf("MaxOpenConnections = %d, want 1", got)
			}
			var busy, foreign int
			var journal string
			if err := db.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != tt.busy {
				t.Fatalf("busy_timeout = %d, err=%v", busy, err)
			}
			if err := db.QueryRow("PRAGMA foreign_keys").Scan(&foreign); err != nil || foreign != 1 {
				t.Fatalf("foreign_keys = %d, err=%v", foreign, err)
			}
			if err := db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil || !strings.EqualFold(journal, tt.journal) {
				t.Fatalf("journal_mode = %q, err=%v", journal, err)
			}
			if err := db.Ping(); err != nil {
				t.Fatalf("Ping: %v", err)
			}
			stats := db.Stats()
			if stats.OpenConnections != 1 || stats.Idle != 1 {
				t.Fatalf("pool stats = open:%d idle:%d, want 1/1", stats.OpenConnections, stats.Idle)
			}
		})
	}
}

func TestSchemaIndexesAndTaskForeignKey(t *testing.T) {
	db := testDBInternal(t)
	for _, name := range []string{"sub_thread_unique", "memory_meta_user_unique", "run_checkpoints_expiry_idx"} {
		var sqlText string
		if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`, name).Scan(&sqlText); err != nil {
			t.Fatalf("index %s: %v", name, err)
		}
		if name != "run_checkpoints_expiry_idx" && !strings.Contains(strings.ToUpper(sqlText), "UNIQUE") {
			t.Fatalf("index %s is not unique: %s", name, sqlText)
		}
		if !strings.Contains(strings.ToUpper(sqlText), "WHERE") {
			t.Fatalf("index %s is not partial: %s", name, sqlText)
		}
	}
	rows, err := db.Query("PRAGMA foreign_key_list(task_run_keys)")
	if err != nil {
		t.Fatalf("foreign_key_list: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("task_run_keys foreign key missing")
	}
}

func TestImmediateTransactionsAcquireWriteLockAtBegin(t *testing.T) {
	path := t.TempDir() + "/locking.db"
	db1, err := Open(path, Options{JournalMode: "WAL", BusyTimeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("Open(db1): %v", err)
	}
	defer db1.Close()
	db2, err := backenddb.OpenSQLite(path, backenddb.SQLiteOptions{JournalMode: "WAL", BusyTimeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("OpenSQLite(db2): %v", err)
	}
	defer db2.Close()
	tx, err := db1.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx(db1): %v", err)
	}
	defer tx.Rollback()
	if tx2, err := db2.BeginTx(context.Background(), nil); err == nil {
		tx2.Rollback()
		t.Fatal("second IMMEDIATE transaction unexpectedly acquired the write lock")
	}
}

func testDBInternal(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
