package sqliterepo_test

import (
	"database/sql"
	"testing"

	"backend/agent"
	"backend/dispatcher"
	"backend/memory"
	"backend/repo/conformancetest"
	"backend/repo/sqliterepo"
)

var (
	_ agent.CheckpointStore          = (*sqliterepo.RunRepo)(nil)
	_ conformancetest.RunStore       = (*sqliterepo.RunRepo)(nil)
	_ conformancetest.TaskStore      = (*sqliterepo.TaskRepo)(nil)
	_ memory.MetaStore               = (*sqliterepo.MemoryMetaRepo)(nil)
	_ memory.RevisionStore           = (*sqliterepo.MemoryRevisionRepo)(nil)
	_ dispatcher.ThreadStore         = (*sqliterepo.ThreadRepo)(nil)
	_ dispatcher.MessageStore        = (*sqliterepo.MessageRepo)(nil)
	_ conformancetest.ThreadStore    = (*sqliterepo.ThreadRepo)(nil)
	_ conformancetest.MessageStore   = (*sqliterepo.MessageRepo)(nil)
	_ agent.AsyncJobStore            = (*sqliterepo.JobRepo)(nil)
	_ dispatcher.CoordinatorJobStore = (*sqliterepo.JobRepo)(nil)
	_ dispatcher.WorkerJobStore      = (*sqliterepo.JobRepo)(nil)
	_ dispatcher.CoordinatorRunStore = (*sqliterepo.RunRepo)(nil)
	_ dispatcher.DurableCancelStore  = (*sqliterepo.TaskRepo)(nil)
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sqliterepo.Open(":memory:", sqliterepo.Options{JournalMode: "MEMORY"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestRunRepoConformance(t *testing.T) {
	conformancetest.RunCheckpointConformance(t, func(t *testing.T) conformancetest.RunStore {
		return sqliterepo.NewRunRepo(testDB(t))
	})
}

func TestTaskRepoConformance(t *testing.T) {
	conformancetest.RunTaskBudgetConformance(t, func(t *testing.T) conformancetest.TaskStore {
		return sqliterepo.NewTaskRepo(testDB(t))
	})
}

func TestMemoryMetaRepoConformance(t *testing.T) {
	conformancetest.RunMemoryMetaConformance(t, func(t *testing.T) memory.MetaStore {
		return sqliterepo.NewMemoryMetaRepo(testDB(t))
	})
}

func TestMemoryRevisionRepoConformance(t *testing.T) {
	conformancetest.RunMemoryRevisionConformance(t, func(t *testing.T) memory.RevisionStore {
		return sqliterepo.NewMemoryRevisionRepo(testDB(t))
	})
}

func TestThreadRepoConformance(t *testing.T) {
	conformancetest.RunThreadConformance(t, func(t *testing.T) conformancetest.ThreadStore {
		return sqliterepo.NewThreadRepo(testDB(t))
	})
}

func TestMessageRepoConformance(t *testing.T) {
	conformancetest.RunMessageConformance(t, func(t *testing.T) conformancetest.MessageStore {
		return sqliterepo.NewMessageRepo(testDB(t))
	})
}

func newJobLifecycleStore(t *testing.T) conformancetest.JobLifecycleStore {
	return sqliterepo.NewJobRepo(testDB(t))
}

func TestJobRepoConformance(t *testing.T) {
	conformancetest.RunAsyncJobConformance(t, func(t *testing.T) agent.AsyncJobStore {
		return sqliterepo.NewJobRepo(testDB(t))
	})
}

func TestJobRepoCoordinatorConformance(t *testing.T) {
	conformancetest.RunCoordinatorJobConformance(t, newJobLifecycleStore)
}

func TestJobRepoWorkerConformance(t *testing.T) {
	conformancetest.RunWorkerJobConformance(t, newJobLifecycleStore)
}
