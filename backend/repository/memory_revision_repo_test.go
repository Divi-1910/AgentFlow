package repository_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"backend/memory"
	"backend/repository"
	"backend/runtimectx"
)

func newRevisionRepo(t *testing.T) *repository.MemoryRevisionRepo {
	t.Helper()
	repo := repository.NewMemoryRevisionRepo(col(t, "memory_revisions"))
	if err := repo.EnsureIndexes(context.Background()); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}
	return repo
}

func revisionFor(t *testing.T, scope runtimectx.MemoryScope, memoryID string, revision int, mutationID string) memory.MemoryRevision {
	t.Helper()
	lineageKey, err := memory.LineageKey(scope, memory.ScopeThread, memoryID)
	if err != nil {
		t.Fatalf("LineageKey: %v", err)
	}
	now := time.Now().UTC()
	rev := memory.MemoryRevision{
		LineageKey: lineageKey,
		Revision:   revision,
		MutationID: mutationID,
		RunID:      "run",
		ToolCallID: "call",
		Operation:  memory.OperationCreate,
		UserID:     scope.UserID,
		AgentID:    scope.AgentID,
		ThreadID:   scope.ThreadID,
		MemoryID:   memoryID,
		Scope:      memory.ScopeThread,
		Type:       memory.TypeFact,
		Importance: 0.5,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	bodyPath, err := memory.RevisionBodyRelPath(rev)
	if err != nil {
		t.Fatalf("RevisionBodyRelPath: %v", err)
	}
	rev.BodyPath = bodyPath
	return rev
}

func TestMemoryRevisionRepoAppendCASConflict(t *testing.T) {
	t.Parallel()
	repo := newRevisionRepo(t)
	scope := repoScope()
	ctx := context.Background()

	rev := revisionFor(t, scope, "mem", 1, "run-1:call-1")
	if _, _, err := repo.Append(ctx, rev); err != nil {
		t.Fatalf("Append first: %v", err)
	}
	got, err := repo.FindRevision(ctx, rev.LineageKey, 1)
	if err != nil {
		t.Fatalf("FindRevision: %v", err)
	}
	if got == nil || got.BodyPath != rev.BodyPath {
		t.Fatalf("BodyPath round trip = %+v, want %q", got, rev.BodyPath)
	}
	conflict := revisionFor(t, scope, "mem", 1, "run-1:call-2")
	_, _, err = repo.Append(ctx, conflict)
	if !errors.Is(err, memory.ErrRevisionConflict) {
		t.Fatalf("expected ErrRevisionConflict, got %v", err)
	}
}

func TestMemoryRevisionRepoMutationReplay(t *testing.T) {
	t.Parallel()
	repo := newRevisionRepo(t)
	scope := repoScope()
	ctx := context.Background()

	rev := revisionFor(t, scope, "mem-replay", 1, "run-1:call-1")
	first, replayed, err := repo.Append(ctx, rev)
	if err != nil {
		t.Fatalf("Append first: %v", err)
	}
	if replayed {
		t.Fatal("first append should not be replay")
	}
	second, replayed, err := repo.Append(ctx, rev)
	if err != nil {
		t.Fatalf("Append replay: %v", err)
	}
	if !replayed || second.Revision != first.Revision {
		t.Fatalf("replay = %v rev %d, want true rev %d", replayed, second.Revision, first.Revision)
	}
}

func TestMemoryRevisionRepoSameRawToolCallAcrossRunsIsNotReplay(t *testing.T) {
	t.Parallel()
	repo := newRevisionRepo(t)
	scope := repoScope()
	ctx := context.Background()

	a := revisionFor(t, scope, "run-a", 1, "run-A:same-call")
	b := revisionFor(t, scope, "run-b", 1, "run-B:same-call")
	if _, _, err := repo.Append(ctx, a); err != nil {
		t.Fatalf("Append A: %v", err)
	}
	if _, replayed, err := repo.Append(ctx, b); err != nil || replayed {
		t.Fatalf("Append B err=%v replayed=%v, want success non-replay", err, replayed)
	}
}
