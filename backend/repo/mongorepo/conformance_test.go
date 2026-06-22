package mongorepo_test

import (
	"context"
	"testing"

	"backend/agent"
	"backend/dispatcher"
	"backend/memory"
	"backend/repo/conformancetest"
	"backend/repo/mongorepo"
)

// Compile-time proof that each Mongo repository satisfies its domain port.
//
// These live in a test file on purpose: cutting the dispatcher→mongorepo edge
// means neither package imports the other in production, so the assertions for
// the dispatcher-defined ports cannot sit in `mongorepo` or `dispatcher`
// production code (it would re-introduce the cycle). A test file in
// mongorepo_test imports both freely — test imports never enter the production
// dependency graph — which is exactly where these compile checks belong.
var (
	_ agent.CheckpointStore     = (*mongorepo.RunRepo)(nil)
	_ agent.AsyncJobStore       = (*mongorepo.JobRepo)(nil)
	_ memory.MetaStore          = (*mongorepo.MemoryMetaRepo)(nil)
	_ memory.RevisionStore      = (*mongorepo.MemoryRevisionRepo)(nil)
	_ dispatcher.AgentReader    = (*mongorepo.AgentRepo)(nil)
	_ dispatcher.ThreadStore    = (*mongorepo.ThreadRepo)(nil)
	_ dispatcher.MessageStore   = (*mongorepo.MessageRepo)(nil)
	_ conformancetest.TaskStore = (*mongorepo.TaskRepo)(nil)
)

func TestRunRepoConformance(t *testing.T) {
	conformancetest.RunCheckpointConformance(t, func(t *testing.T) conformancetest.RunStore {
		r := mongorepo.NewRunRepo(col(t, "conf_runs"), col(t, "conf_ckpts"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestTaskRepoConformance(t *testing.T) {
	conformancetest.RunTaskBudgetConformance(t, func(t *testing.T) conformancetest.TaskStore {
		r := mongorepo.NewTaskRepo(col(t, "conf_tasks"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestJobRepoConformance(t *testing.T) {
	conformancetest.RunAsyncJobConformance(t, func(t *testing.T) agent.AsyncJobStore {
		r := mongorepo.NewJobRepo(col(t, "conf_jobs"), col(t, "conf_locks"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestMemoryMetaRepoConformance(t *testing.T) {
	conformancetest.RunMemoryMetaConformance(t, func(t *testing.T) memory.MetaStore {
		r := mongorepo.NewMemoryMetaRepo(col(t, "conf_mem_meta"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestMemoryRevisionRepoConformance(t *testing.T) {
	conformancetest.RunMemoryRevisionConformance(t, func(t *testing.T) memory.RevisionStore {
		r := mongorepo.NewMemoryRevisionRepo(col(t, "conf_mem_rev"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestThreadRepoConformance(t *testing.T) {
	conformancetest.RunThreadConformance(t, func(t *testing.T) conformancetest.ThreadStore {
		r := mongorepo.NewThreadRepo(col(t, "conf_threads"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestMessageRepoConformance(t *testing.T) {
	conformancetest.RunMessageConformance(t, func(t *testing.T) conformancetest.MessageStore {
		return mongorepo.NewMessageRepo(col(t, "conf_messages"))
	})
}
