package memory_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"

	"backend/memory"
	"backend/runtimectx"
)

// ── fakeMetaStore ─────────────────────────────────────────────────────────────

// fakeMetaStore is an in-memory implementation of memory.MetaStore for unit
// tests. It is safe for concurrent use.
type fakeMetaStore struct {
	mu          sync.Mutex
	records     map[string]*memory.MemoryDocument // key: agentID|scope|memoryID
	softDeleted map[string]bool                   // tracks soft-deleted keys
	stampErr    error                             // if non-nil, StampRead returns this error
}

func newFakeMeta() *fakeMetaStore {
	return &fakeMetaStore{
		records:     make(map[string]*memory.MemoryDocument),
		softDeleted: make(map[string]bool),
	}
}

func (f *fakeMetaStore) metaKey(agentID, scope, memoryID string) string {
	return agentID + "|" + scope + "|" + memoryID
}

func (f *fakeMetaStore) Upsert(_ context.Context, doc memory.MemoryDocument) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := f.metaKey(doc.AgentID, doc.Scope, doc.ID)
	// Preserve last_read_at on upsert — mirrors the MongoDB $set behaviour.
	var lastReadAt *time.Time
	if existing, ok := f.records[k]; ok {
		lastReadAt = existing.LastReadAt
	}
	cp := doc
	cp.LastReadAt = lastReadAt
	f.records[k] = &cp
	// Clear any prior soft-delete marker — re-writing revives the slot.
	delete(f.softDeleted, k)
	return nil
}

func (f *fakeMetaStore) FindOne(_ context.Context, agentID, scope, memoryID string) (*memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := f.metaKey(agentID, scope, memoryID)
	if f.softDeleted[k] {
		return nil, nil
	}
	doc, ok := f.records[k]
	if !ok {
		return nil, nil
	}
	cp := *doc
	return &cp, nil
}

func (f *fakeMetaStore) FindActive(_ context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, now time.Time) ([]memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var results []memory.MemoryDocument
	for k, doc := range f.records {
		if f.softDeleted[k] {
			continue // soft-deleted — invisible to agents
		}
		if doc.ExpiresAt != nil && !doc.ExpiresAt.After(now) {
			continue // expired
		}
		if !scopeMatch(doc, execScope, searchScope) {
			continue
		}
		if typeFilter != nil && doc.Type != *typeFilter {
			continue
		}
		cp := *doc
		results = append(results, cp)
	}
	return results, nil
}

func scopeMatch(doc *memory.MemoryDocument, exec runtimectx.MemoryScope, searchScope string) bool {
	switch searchScope {
	case memory.ScopeThread:
		return doc.Scope == memory.ScopeThread &&
			doc.AgentID == exec.AgentID &&
			doc.ThreadID == exec.ThreadID
	case memory.ScopeAgent:
		return (doc.Scope == memory.ScopeAgent && doc.AgentID == exec.AgentID) ||
			(doc.Scope == memory.ScopeThread && doc.AgentID == exec.AgentID && doc.ThreadID == exec.ThreadID)
	case memory.ScopeUser:
		return (doc.Scope == memory.ScopeUser && doc.UserID == exec.UserID) ||
			(doc.Scope == memory.ScopeAgent && doc.AgentID == exec.AgentID) ||
			(doc.Scope == memory.ScopeThread && doc.AgentID == exec.AgentID && doc.ThreadID == exec.ThreadID)
	default:
		return false
	}
}

func (f *fakeMetaStore) StampRead(_ context.Context, agentID, scope, memoryID string) error {
	if f.stampErr != nil {
		return f.stampErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	doc, ok := f.records[f.metaKey(agentID, scope, memoryID)]
	if !ok {
		return nil // no-op for nonexistent record, matches MongoDB behaviour
	}
	now := time.Now().UTC()
	doc.LastReadAt = &now
	return nil
}

func (f *fakeMetaStore) FindExpired(_ context.Context, now time.Time) ([]memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var results []memory.MemoryDocument
	for k, doc := range f.records {
		if f.softDeleted[k] {
			continue // already soft-deleted — don't re-process
		}
		if doc.ExpiresAt != nil && !doc.ExpiresAt.After(now) {
			cp := *doc
			results = append(results, cp)
		}
	}
	return results, nil
}

func (f *fakeMetaStore) SoftDelete(_ context.Context, agentID, scope, memoryID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := f.metaKey(agentID, scope, memoryID)
	if _, ok := f.records[k]; ok {
		f.softDeleted[k] = true
	}
	return nil
}

func (f *fakeMetaStore) EnsureIndexes(_ context.Context) error { return nil }

// ── Test helpers ──────────────────────────────────────────────────────────────

// newSvc creates a Service with a fresh temp root and a fakeMetaStore.
func newSvc(t *testing.T) (*memory.Service, string, *fakeMetaStore) {
	t.Helper()
	root := t.TempDir()
	meta := newFakeMeta()
	svc := memory.NewService(memory.Config{Root: root}, meta)
	return svc, root, meta
}

// svcWriteArgs returns a minimal valid MemoryWriteArgs for the given content.
func svcWriteArgs(content string) memory.MemoryWriteArgs {
	return memory.MemoryWriteArgs{
		Content:    content,
		Type:       memory.TypeFact,
		Scope:      memory.ScopeThread,
		Importance: 0.7,
	}
}

// writeExpiredDoc plants an expired record into both the fakeMetaStore and the
// filesystem (plain text body, no frontmatter).
func writeExpiredDoc(t *testing.T, root string, scope runtimectx.MemoryScope, memID string, meta *fakeMetaStore) {
	t.Helper()
	past := time.Now().UTC().Add(-48 * time.Hour)
	expiresAt := time.Now().UTC().Add(-1 * time.Hour)

	path, err := memory.ResolveWritePath(root, scope, memory.ScopeThread, memID)
	if err != nil {
		t.Fatalf("ResolveWritePath: %v", err)
	}
	if err := memory.WriteFileAtomic(path, "expired content"); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}

	doc := memory.MemoryDocument{
		UserID:     scope.UserID,
		AgentID:    scope.AgentID,
		ThreadID:   scope.ThreadID,
		ID:         memID,
		Type:       memory.TypeFact,
		Scope:      memory.ScopeThread,
		Importance: 0.5,
		CreatedAt:  past,
		ExpiresAt:  &expiresAt,
	}
	if err := meta.Upsert(context.Background(), doc); err != nil {
		t.Fatalf("fakeMetaStore.Upsert: %v", err)
	}
}

// newSearchSvc creates a Service with rg wired in; skips if rg is not in PATH.
func newSearchSvc(t *testing.T) (*memory.Service, string, *fakeMetaStore) {
	t.Helper()
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not in PATH — skipping search test")
	}
	root := t.TempDir()
	meta := newFakeMeta()
	svc := memory.NewService(memory.Config{Root: root, RGPath: "rg"}, meta)
	return svc, root, meta
}

// ── Write ─────────────────────────────────────────────────────────────────────

func TestServiceWriteRoundTrip(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)

	result, err := svc.Write(context.Background(), validScope(), "mem-rt", svcWriteArgs("hello world"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if result.MemoryID != "mem-rt" {
		t.Errorf("MemoryID: got %q, want %q", result.MemoryID, "mem-rt")
	}
	if result.Scope != memory.ScopeThread {
		t.Errorf("Scope: got %q, want %q", result.Scope, memory.ScopeThread)
	}
	if result.CreatedAt == "" {
		t.Error("expected non-empty CreatedAt")
	}
}

func TestServiceWriteExistingFileRequiresRead(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	scope := validScope()

	// First write — new file, must succeed.
	if _, err := svc.Write(context.Background(), scope, "mem-guard", svcWriteArgs("initial content")); err != nil {
		t.Fatalf("first Write: %v", err)
	}

	// Second write without reading — must fail with ErrReadBeforeWrite.
	_, err := svc.Write(context.Background(), scope, "mem-guard", svcWriteArgs("overwrite attempt"))
	if !errors.Is(err, memory.ErrReadBeforeWrite) {
		t.Fatalf("expected ErrReadBeforeWrite on blind overwrite, got: %v", err)
	}
}

func TestServiceWriteAllowedAfterRead(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	scope := validScope()

	// Write → Read (stamps last_read_at) → Write again must succeed.
	if _, err := svc.Write(context.Background(), scope, "mem-rw", svcWriteArgs("v1")); err != nil {
		t.Fatalf("first Write: %v", err)
	}
	if _, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-rw", Scope: memory.ScopeThread,
	}); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if _, err := svc.Write(context.Background(), scope, "mem-rw", svcWriteArgs("v2")); err != nil {
		t.Fatalf("second Write after Read: %v", err)
	}
}

func TestServiceWriteExpiredWindowRequiresReRead(t *testing.T) {
	t.Parallel()
	meta := newFakeMeta()
	svc := memory.NewService(memory.Config{Root: t.TempDir(), ReadWindowDuration: 5 * time.Minute}, meta)
	scope := validScope()

	// Seed a non-expired record with a stale last_read_at (10 minutes ago,
	// outside the 5-minute window).
	staleRead := time.Now().UTC().Add(-10 * time.Minute)
	doc := memory.MemoryDocument{
		UserID:     scope.UserID,
		AgentID:    scope.AgentID,
		ThreadID:   scope.ThreadID,
		ID:         "mem-stale",
		Type:       memory.TypeFact,
		Scope:      memory.ScopeThread,
		Importance: 0.5,
		CreatedAt:  time.Now().UTC().Add(-1 * time.Hour),
		LastReadAt: &staleRead,
	}
	if err := meta.Upsert(context.Background(), doc); err != nil {
		t.Fatalf("seed Upsert: %v", err)
	}

	// The guardrail fires before the file write, so no file is needed.
	_, err := svc.Write(context.Background(), scope, "mem-stale", svcWriteArgs("new content"))
	if !errors.Is(err, memory.ErrReadBeforeWrite) {
		t.Fatalf("expected ErrReadBeforeWrite for stale stamp, got: %v", err)
	}
}

func TestServiceWriteExpiredRecordTreatedAsNew(t *testing.T) {
	t.Parallel()
	svc, root, meta := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-reexp", meta)

	// Write over expired record — no read required.
	if _, err := svc.Write(context.Background(), scope, "mem-reexp", svcWriteArgs("fresh content")); err != nil {
		t.Fatalf("Write over expired record: %v", err)
	}
}

func TestServiceWriteOverwritesExpiredDoc(t *testing.T) {
	t.Parallel()
	svc, root, meta := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-exp", meta)

	// Write must succeed and the new content must be readable.
	result, err := svc.Write(context.Background(), scope, "mem-exp", svcWriteArgs("fresh content"))
	if err != nil {
		t.Fatalf("Write over expired doc: %v", err)
	}
	if result.MemoryID != "mem-exp" {
		t.Errorf("MemoryID: got %q, want %q", result.MemoryID, "mem-exp")
	}

	read, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-exp",
		Scope:    memory.ScopeThread,
	})
	if err != nil {
		t.Fatalf("Read after overwrite: %v", err)
	}
	if read.Content != "fresh content" {
		t.Errorf("Content: got %q, want %q", read.Content, "fresh content")
	}
}

func TestServiceWriteWithTTLSetsExpiresAt(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	ttl := 3
	args := svcWriteArgs("temporary fact")
	args.TTLDays = &ttl

	result, err := svc.Write(context.Background(), validScope(), "mem-ttl", args)
	if err != nil {
		t.Fatalf("Write with TTL: %v", err)
	}
	if result.ExpiresAt == nil {
		t.Fatal("expected ExpiresAt to be set when TTLDays is provided")
	}
}

func TestServiceWriteRejectsEmptyContent(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	_, err := svc.Write(context.Background(), validScope(), "mem-empty", svcWriteArgs(""))
	if err == nil {
		t.Fatal("expected error for empty content")
	}
}

func TestServiceWriteRejectsInvalidType(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	args := svcWriteArgs("some content")
	args.Type = "not-a-type"
	_, err := svc.Write(context.Background(), validScope(), "mem-badtype", args)
	if !errors.Is(err, memory.ErrInvalidType) {
		t.Fatalf("expected ErrInvalidType, got: %v", err)
	}
}

func TestServiceWriteRejectsInvalidScope(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	args := svcWriteArgs("some content")
	args.Scope = "badscope"
	_, err := svc.Write(context.Background(), validScope(), "mem-badscope", args)
	if !errors.Is(err, memory.ErrInvalidScope) {
		t.Fatalf("expected ErrInvalidScope, got: %v", err)
	}
}

// ── Read ──────────────────────────────────────────────────────────────────────

func TestServiceReadRoundTrip(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	scope := validScope()

	if _, err := svc.Write(context.Background(), scope, "mem-read", svcWriteArgs("content to read back")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	result, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-read",
		Scope:    memory.ScopeThread,
	})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if result.Content != "content to read back" {
		t.Errorf("Content: got %q, want %q", result.Content, "content to read back")
	}
	if result.Type != memory.TypeFact {
		t.Errorf("Type: got %q, want %q", result.Type, memory.TypeFact)
	}
	if result.MemoryID != "mem-read" {
		t.Errorf("MemoryID: got %q, want %q", result.MemoryID, "mem-read")
	}
}

func TestServiceReadReturnsErrMemoryNotFound(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSvc(t)
	_, err := svc.Read(context.Background(), validScope(), memory.MemoryReadArgs{
		MemoryID: "mem-nonexistent",
		Scope:    memory.ScopeThread,
	})
	if !errors.Is(err, memory.ErrMemoryNotFound) {
		t.Fatalf("expected ErrMemoryNotFound, got: %v", err)
	}
}

func TestServiceReadReturnsErrExpiredMemory(t *testing.T) {
	t.Parallel()
	svc, root, meta := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-readexp", meta)

	_, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-readexp",
		Scope:    memory.ScopeThread,
	})
	if !errors.Is(err, memory.ErrExpiredMemory) {
		t.Fatalf("expected ErrExpiredMemory, got: %v", err)
	}
}

func TestServiceReadStampsLastReadAt(t *testing.T) {
	t.Parallel()
	svc, _, meta := newSvc(t)
	scope := validScope()

	if _, err := svc.Write(context.Background(), scope, "mem-stamp", svcWriteArgs("content")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-stamp", Scope: memory.ScopeThread,
	}); err != nil {
		t.Fatalf("Read: %v", err)
	}

	doc, err := meta.FindOne(context.Background(), scope.AgentID, memory.ScopeThread, "mem-stamp")
	if err != nil {
		t.Fatalf("FindOne: %v", err)
	}
	if doc == nil || doc.LastReadAt == nil {
		t.Fatal("expected LastReadAt to be set after Read")
	}
}

func TestServiceReadStampFailureDoesNotFailRead(t *testing.T) {
	t.Parallel()
	svc, _, meta := newSvc(t)
	scope := validScope()

	if _, err := svc.Write(context.Background(), scope, "mem-sfail", svcWriteArgs("content")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	meta.stampErr = errors.New("simulated stamp failure")

	result, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-sfail", Scope: memory.ScopeThread,
	})
	if err != nil {
		t.Fatalf("Read should succeed even when stamp fails, got: %v", err)
	}
	if result.Content != "content" {
		t.Errorf("Content: got %q, want %q", result.Content, "content")
	}
}

// ── Search ────────────────────────────────────────────────────────────────────

func TestServiceSearchFindsMatch(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSearchSvc(t)
	scope := validScope()

	if _, err := svc.Write(context.Background(), scope, "mem-match",
		svcWriteArgs("the quick brown fox")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	resp, err := svc.Search(context.Background(), scope, memory.MemorySearchArgs{
		Pattern: "quick brown",
		Scope:   memory.ScopeThread,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(resp.Results) == 0 {
		t.Fatal("expected at least 1 search result")
	}
	if resp.Results[0].MemoryID != "mem-match" {
		t.Errorf("MemoryID: got %q, want %q", resp.Results[0].MemoryID, "mem-match")
	}
}

func TestServiceSearchReturnsEmptyOnNoMatch(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSearchSvc(t)
	scope := validScope()

	if _, err := svc.Write(context.Background(), scope, "mem-nomatch",
		svcWriteArgs("something unrelated")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	resp, err := svc.Search(context.Background(), scope, memory.MemorySearchArgs{
		Pattern: "zzznomatchzzz",
		Scope:   memory.ScopeThread,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(resp.Results) != 0 {
		t.Errorf("expected 0 results, got %d", len(resp.Results))
	}
}

// ── Cleanup worker ────────────────────────────────────────────────────────────

func TestCleanupSoftDeletesExpiredRecords(t *testing.T) {
	t.Parallel()
	svc, root, meta := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-cleanup", meta)

	// runCleanup is unexported; trigger via a very short-interval worker.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc.StartCleanupWorker(ctx, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond) // let at least one tick fire

	// Record must now be invisible to agents.
	doc, err := meta.FindOne(context.Background(), scope.AgentID, memory.ScopeThread, "mem-cleanup")
	if err != nil {
		t.Fatalf("FindOne after cleanup: %v", err)
	}
	if doc != nil {
		t.Error("expected soft-deleted record to be invisible (FindOne should return nil)")
	}
}

func TestCleanupSkipsActiveRecords(t *testing.T) {
	t.Parallel()
	svc, _, meta := newSvc(t)
	scope := validScope()

	if _, err := svc.Write(context.Background(), scope, "mem-active", svcWriteArgs("keep me")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc.StartCleanupWorker(ctx, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond)

	// Active record must still be visible.
	doc, err := meta.FindOne(context.Background(), scope.AgentID, memory.ScopeThread, "mem-active")
	if err != nil {
		t.Fatalf("FindOne after cleanup: %v", err)
	}
	if doc == nil {
		t.Error("expected active record to still be visible after cleanup sweep")
	}
}

func TestCleanupFilePreservedOnDisk(t *testing.T) {
	t.Parallel()
	svc, root, meta := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-audit", meta)

	path, err := memory.ResolveWritePath(root, scope, memory.ScopeThread, "mem-audit")
	if err != nil {
		t.Fatalf("ResolveWritePath: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc.StartCleanupWorker(ctx, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond)

	// File must still exist on disk after soft-delete.
	if _, statErr := os.Stat(path); statErr != nil {
		t.Errorf("expected file to remain on disk for audit, got: %v", statErr)
	}
}

func TestServiceSearchRespectsLimit(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSearchSvc(t)
	scope := validScope()

	for i, id := range []string{"mem-sl1", "mem-sl2", "mem-sl3"} {
		if _, err := svc.Write(context.Background(), scope, id,
			svcWriteArgs(fmt.Sprintf("targetword doc number %d", i+1))); err != nil {
			t.Fatalf("Write %s: %v", id, err)
		}
	}

	limit := 2
	resp, err := svc.Search(context.Background(), scope, memory.MemorySearchArgs{
		Pattern: "targetword",
		Scope:   memory.ScopeThread,
		Limit:   &limit,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(resp.Results) > 2 {
		t.Errorf("expected at most 2 results with limit=2, got %d", len(resp.Results))
	}
}
