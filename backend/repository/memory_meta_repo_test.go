package repository_test

import (
	"context"
	"testing"
	"time"

	"backend/memory"
	"backend/repository"
	"backend/runtimectx"
)

func newMetaRepo(t *testing.T) *repository.MemoryMetaRepo {
	t.Helper()
	c := col(t, "memory_meta")
	repo := repository.NewMemoryMetaRepo(c)
	if err := repo.EnsureIndexes(context.Background()); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}
	return repo
}

func repoScope() runtimectx.MemoryScope {
	return runtimectx.MemoryScope{UserID: "user-1", AgentID: "agent-1", ThreadID: "thread-1"}
}

// ── Upsert + FindOne ──────────────────────────────────────────────────────────

func TestMemoryMetaRepoUpsertAndFindOne(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC().Truncate(time.Millisecond)

	doc := memory.MemoryDocument{
		UserID:     scope.UserID,
		AgentID:    scope.AgentID,
		ThreadID:   scope.ThreadID,
		ID:         "mem-1",
		Type:       memory.TypeFact,
		Scope:      memory.ScopeThread,
		Importance: 0.8,
		CreatedAt:  now,
	}

	if err := repo.Upsert(ctx, doc); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	got, err := repo.FindOne(ctx, scope.AgentID, memory.ScopeThread, "mem-1")
	if err != nil {
		t.Fatalf("FindOne: %v", err)
	}
	if got == nil {
		t.Fatal("expected record, got nil")
	}
	if got.ID != "mem-1" {
		t.Errorf("ID: got %q, want %q", got.ID, "mem-1")
	}
	if got.Type != memory.TypeFact {
		t.Errorf("Type: got %q, want %q", got.Type, memory.TypeFact)
	}
	if got.Importance != 0.8 {
		t.Errorf("Importance: got %f, want 0.8", got.Importance)
	}
	if got.AgentID != scope.AgentID {
		t.Errorf("AgentID: got %q, want %q", got.AgentID, scope.AgentID)
	}
}

func TestMemoryMetaRepoFindOneNotFound(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)

	got, err := repo.FindOne(context.Background(), "agent-1", memory.ScopeThread, "nonexistent")
	if err != nil {
		t.Fatalf("FindOne: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for nonexistent record, got %+v", got)
	}
}

func TestMemoryMetaRepoUpsertUpdatesExisting(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC().Truncate(time.Millisecond)

	doc := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		ID: "mem-upd", Type: memory.TypeFact, Scope: memory.ScopeThread,
		Importance: 0.5, CreatedAt: now,
	}
	if err := repo.Upsert(ctx, doc); err != nil {
		t.Fatalf("first Upsert: %v", err)
	}

	doc.Importance = 0.9
	if err := repo.Upsert(ctx, doc); err != nil {
		t.Fatalf("second Upsert: %v", err)
	}

	got, err := repo.FindOne(ctx, scope.AgentID, memory.ScopeThread, "mem-upd")
	if err != nil {
		t.Fatalf("FindOne: %v", err)
	}
	if got.Importance != 0.9 {
		t.Errorf("Importance after update: got %f, want 0.9", got.Importance)
	}
}

func TestMemoryMetaRepoUpsertPreservesLastReadAt(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC().Truncate(time.Millisecond)

	doc := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		ID: "mem-lra", Type: memory.TypeFact, Scope: memory.ScopeThread,
		Importance: 0.5, CreatedAt: now,
	}
	if err := repo.Upsert(ctx, doc); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := repo.StampRead(ctx, scope.AgentID, memory.ScopeThread, "mem-lra"); err != nil {
		t.Fatalf("StampRead: %v", err)
	}

	// Re-upsert with different importance — last_read_at must be preserved.
	doc.Importance = 0.9
	if err := repo.Upsert(ctx, doc); err != nil {
		t.Fatalf("second Upsert: %v", err)
	}

	got, err := repo.FindOne(ctx, scope.AgentID, memory.ScopeThread, "mem-lra")
	if err != nil {
		t.Fatalf("FindOne: %v", err)
	}
	if got.LastReadAt == nil {
		t.Error("expected LastReadAt to be preserved after re-upsert, got nil")
	}
}

// ── StampRead ─────────────────────────────────────────────────────────────────

func TestMemoryMetaRepoStampRead(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC().Truncate(time.Millisecond)

	doc := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		ID: "mem-stamp", Type: memory.TypeFact, Scope: memory.ScopeThread,
		Importance: 0.5, CreatedAt: now,
	}
	if err := repo.Upsert(ctx, doc); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := repo.StampRead(ctx, scope.AgentID, memory.ScopeThread, "mem-stamp"); err != nil {
		t.Fatalf("StampRead: %v", err)
	}

	got, err := repo.FindOne(ctx, scope.AgentID, memory.ScopeThread, "mem-stamp")
	if err != nil {
		t.Fatalf("FindOne: %v", err)
	}
	if got.LastReadAt == nil {
		t.Fatal("expected LastReadAt to be set after StampRead")
	}
	if time.Since(*got.LastReadAt) > 10*time.Second {
		t.Errorf("LastReadAt is too old: %v", *got.LastReadAt)
	}
}

// ── FindActive ────────────────────────────────────────────────────────────────

func TestMemoryMetaRepoFindActiveThreadScope(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC()

	base := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		Type: memory.TypeFact, Importance: 0.5, CreatedAt: now,
	}
	d1 := base; d1.ID = "t1"; d1.Scope = memory.ScopeThread
	d2 := base; d2.ID = "t2"; d2.Scope = memory.ScopeThread
	d3 := base; d3.ID = "a1"; d3.Scope = memory.ScopeAgent

	for _, d := range []memory.MemoryDocument{d1, d2, d3} {
		if err := repo.Upsert(ctx, d); err != nil {
			t.Fatalf("Upsert %s: %v", d.ID, err)
		}
	}

	docs, err := repo.FindActive(ctx, scope, memory.ScopeThread, nil, now)
	if err != nil {
		t.Fatalf("FindActive: %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("expected 2 thread docs, got %d", len(docs))
	}
}

func TestMemoryMetaRepoFindActiveAgentScope(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC()

	base := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		Type: memory.TypeFact, Importance: 0.5, CreatedAt: now,
	}
	d1 := base; d1.ID = "t1"; d1.Scope = memory.ScopeThread
	d2 := base; d2.ID = "t2"; d2.Scope = memory.ScopeThread
	d3 := base; d3.ID = "a1"; d3.Scope = memory.ScopeAgent

	for _, d := range []memory.MemoryDocument{d1, d2, d3} {
		if err := repo.Upsert(ctx, d); err != nil {
			t.Fatalf("Upsert %s: %v", d.ID, err)
		}
	}

	docs, err := repo.FindActive(ctx, scope, memory.ScopeAgent, nil, now)
	if err != nil {
		t.Fatalf("FindActive: %v", err)
	}
	if len(docs) != 3 {
		t.Errorf("expected 3 docs (agent scope includes thread), got %d", len(docs))
	}
}

func TestMemoryMetaRepoFindActiveFiltersExpired(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC()
	past := now.Add(-1 * time.Hour)

	base := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		Scope: memory.ScopeThread, Type: memory.TypeFact, Importance: 0.5, CreatedAt: now,
	}
	active := base; active.ID = "active"
	expired := base; expired.ID = "expired"; expired.ExpiresAt = &past

	for _, d := range []memory.MemoryDocument{active, expired} {
		if err := repo.Upsert(ctx, d); err != nil {
			t.Fatalf("Upsert %s: %v", d.ID, err)
		}
	}

	docs, err := repo.FindActive(ctx, scope, memory.ScopeThread, nil, now)
	if err != nil {
		t.Fatalf("FindActive: %v", err)
	}
	if len(docs) != 1 {
		t.Errorf("expected 1 active doc (expired filtered out), got %d", len(docs))
	}
	if docs[0].ID != "active" {
		t.Errorf("expected active doc, got %q", docs[0].ID)
	}
}

func TestMemoryMetaRepoFindActiveFiltersType(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	scope := repoScope()
	now := time.Now().UTC()

	base := memory.MemoryDocument{
		UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
		Scope: memory.ScopeThread, Importance: 0.5, CreatedAt: now,
	}
	f1 := base; f1.ID = "f1"; f1.Type = memory.TypeFact
	f2 := base; f2.ID = "f2"; f2.Type = memory.TypeFact
	p1 := base; p1.ID = "p1"; p1.Type = memory.TypePreference

	for _, d := range []memory.MemoryDocument{f1, f2, p1} {
		if err := repo.Upsert(ctx, d); err != nil {
			t.Fatalf("Upsert %s: %v", d.ID, err)
		}
	}

	typeFilter := memory.TypeFact
	docs, err := repo.FindActive(ctx, scope, memory.ScopeThread, &typeFilter, now)
	if err != nil {
		t.Fatalf("FindActive: %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("expected 2 fact docs, got %d", len(docs))
	}
}

// ── Isolation ─────────────────────────────────────────────────────────────────

func TestMemoryMetaRepoKeyIsolation(t *testing.T) {
	t.Parallel()
	repo := newMetaRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	// Write agent-A's record and stamp it.
	docA := memory.MemoryDocument{
		UserID: "user-a", AgentID: "agent-a", ThreadID: "thread-a",
		ID: "mem-1", Scope: memory.ScopeThread, Type: memory.TypeFact,
		Importance: 0.5, CreatedAt: now,
	}
	if err := repo.Upsert(ctx, docA); err != nil {
		t.Fatalf("Upsert agent-A: %v", err)
	}
	if err := repo.StampRead(ctx, "agent-a", memory.ScopeThread, "mem-1"); err != nil {
		t.Fatalf("StampRead: %v", err)
	}

	// Agent-B querying the same key must get nil.
	got, err := repo.FindOne(ctx, "agent-b", memory.ScopeThread, "mem-1")
	if err != nil {
		t.Fatalf("FindOne agent-B: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for agent-B query, got %+v", got)
	}
}
