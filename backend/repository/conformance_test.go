package repository_test

import (
	"context"
	"testing"

	"backend/agent"
	"backend/dispatcher"
	"backend/memory"
	"backend/repository"
	"backend/repository/conformancetest"
)

// Compile-time proof that each Mongo repository satisfies its domain port.
//
// These live in a test file on purpose: cutting the dispatcher→repository edge
// means neither package imports the other in production, so the assertions for
// the dispatcher-defined ports cannot sit in `repository` or `dispatcher`
// production code (it would re-introduce the cycle). A test file in
// repository_test imports both freely — test imports never enter the production
// dependency graph — which is exactly where these compile checks belong.
var (
	_ agent.CheckpointStore     = (*repository.RunRepo)(nil)
	_ agent.AsyncJobStore       = (*repository.JobRepo)(nil)
	_ memory.MetaStore          = (*repository.MemoryMetaRepo)(nil)
	_ memory.RevisionStore      = (*repository.MemoryRevisionRepo)(nil)
	_ dispatcher.AgentReader    = (*repository.AgentRepo)(nil)
	_ dispatcher.ThreadStore    = (*repository.ThreadRepo)(nil)
	_ dispatcher.MessageStore   = (*repository.MessageRepo)(nil)
	_ conformancetest.TaskStore = (*repository.TaskRepo)(nil)
)

func TestRunRepoConformance(t *testing.T) {
	conformancetest.RunCheckpointConformance(t, func(t *testing.T) agent.CheckpointStore {
		r := repository.NewRunRepo(col(t, "conf_runs"), col(t, "conf_ckpts"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestTaskRepoConformance(t *testing.T) {
	conformancetest.RunTaskBudgetConformance(t, func(t *testing.T) conformancetest.TaskStore {
		r := repository.NewTaskRepo(col(t, "conf_tasks"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestJobRepoConformance(t *testing.T) {
	conformancetest.RunAsyncJobConformance(t, func(t *testing.T) agent.AsyncJobStore {
		r := repository.NewJobRepo(col(t, "conf_jobs"), col(t, "conf_locks"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestMemoryMetaRepoConformance(t *testing.T) {
	conformancetest.RunMemoryMetaConformance(t, func(t *testing.T) memory.MetaStore {
		r := repository.NewMemoryMetaRepo(col(t, "conf_mem_meta"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestMemoryRevisionRepoConformance(t *testing.T) {
	conformancetest.RunMemoryRevisionConformance(t, func(t *testing.T) memory.RevisionStore {
		r := repository.NewMemoryRevisionRepo(col(t, "conf_mem_rev"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestThreadRepoConformance(t *testing.T) {
	conformancetest.RunThreadConformance(t, func(t *testing.T) conformancetest.ThreadStore {
		r := repository.NewThreadRepo(col(t, "conf_threads"))
		if err := r.EnsureIndexes(context.Background()); err != nil {
			t.Fatalf("EnsureIndexes: %v", err)
		}
		return r
	})
}

func TestMessageRepoConformance(t *testing.T) {
	conformancetest.RunMessageConformance(t, func(t *testing.T) conformancetest.MessageStore {
		return repository.NewMessageRepo(col(t, "conf_messages"))
	})
}
