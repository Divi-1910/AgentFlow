package sqliterepo

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"testing"
	"time"

	backenddb "backend/db"
	"backend/model"
)

func openIdentityTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMigrationV2ToV3PreservesState(t *testing.T) {
	db, err := backenddb.OpenSQLite(":memory:", backenddb.SQLiteOptions{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := migrate(context.Background(), db, migrations[:2]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO threads(id, user_id, agent_id, title, created_at, updated_at) VALUES('t', 'u', 'a', 'kept', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var version int
	var title string
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT title FROM threads WHERE id = 't'`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if version != 3 || title != "kept" {
		t.Fatalf("version/title = %d/%q", version, title)
	}
	if _, err := db.Exec(`SELECT singleton FROM deployment_identity`); err != nil {
		t.Fatalf("deployment_identity missing: %v", err)
	}
}

func TestDeploymentIdentityBindAndMismatch(t *testing.T) {
	db := openIdentityTestDB(t)
	repo := NewDeploymentIdentityRepo(db)
	binding := DeploymentBinding{DeploymentID: "dep-a", ConfigHash: strings.Repeat("a", 64), SyntheticUserID: "runtime_a"}
	if err := repo.Bind(context.Background(), binding); err != nil {
		t.Fatal(err)
	}
	if err := repo.Bind(context.Background(), binding); err != nil {
		t.Fatalf("identical rebind: %v", err)
	}
	mismatch := binding
	mismatch.ConfigHash = strings.Repeat("b", 64)
	if err := repo.Bind(context.Background(), mismatch); err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("mismatched bind = %v", err)
	}
	var stored string
	if err := db.QueryRow(`SELECT config_hash FROM deployment_identity WHERE singleton = 1`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != binding.ConfigHash {
		t.Fatalf("binding mutated to %s", stored)
	}
}

func TestDeploymentIdentityConcurrentBindConverges(t *testing.T) {
	db := openIdentityTestDB(t)
	repo := NewDeploymentIdentityRepo(db)
	binding := DeploymentBinding{DeploymentID: "dep", ConfigHash: strings.Repeat("c", 64), SyntheticUserID: "runtime_c"}
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- repo.Bind(context.Background(), binding)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestRecoverOrphanedRuns(t *testing.T) {
	db := openIdentityTestDB(t)
	runs := NewRunRepo(db)
	ctx := context.Background()
	if err := runs.CreateRun(ctx, "with-checkpoint", "thread-a", "agent", "owner"); err != nil {
		t.Fatal(err)
	}
	if err := runs.CreateRun(ctx, "without-checkpoint", "thread-b", "agent", "owner"); err != nil {
		t.Fatal(err)
	}
	if err := runs.CreateRun(ctx, "other-owner", "thread-c", "agent", "other"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO run_checkpoints(run_id, step, snapshot_gz, created_at) VALUES(?, 0, ?, ?)`,
		"with-checkpoint", []byte("not-read-by-recovery"), time.Now().UnixNano()); err != nil {
		t.Fatal(err)
	}
	result, err := runs.RecoverOrphanedRuns(ctx, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if result.Interrupted != 1 || result.Failed != 1 {
		t.Fatalf("recovery = %+v", result)
	}
	assertRunStatus := func(id string, want model.RunStatus) {
		t.Helper()
		var got string
		if err := db.QueryRow(`SELECT status FROM runs WHERE run_id = ?`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != string(want) {
			t.Fatalf("run %s status = %s, want %s", id, got, want)
		}
	}
	assertRunStatus("with-checkpoint", model.RunStatusInterrupted)
	assertRunStatus("without-checkpoint", model.RunStatusFailed)
	assertRunStatus("other-owner", model.RunStatusRunning)
}
