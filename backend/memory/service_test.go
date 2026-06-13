package memory_test

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/memory"
	"backend/runtimectx"
)

type fakeMetaStore struct {
	mu       sync.Mutex
	records  map[string]*memory.MemoryDocument
	stampErr error
}

func newFakeMeta() *fakeMetaStore {
	return &fakeMetaStore{records: make(map[string]*memory.MemoryDocument)}
}

func (f *fakeMetaStore) Upsert(_ context.Context, doc memory.MemoryDocument) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, ok := f.records[doc.LineageKey]; ok {
		if existing.Revision > doc.Revision {
			return nil
		}
		doc.LastReadAt = existing.LastReadAt
	}
	cp := doc
	f.records[doc.LineageKey] = &cp
	return nil
}

func (f *fakeMetaStore) FindActive(_ context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, includeRetired bool, now time.Time) ([]memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []memory.MemoryDocument
	for _, doc := range f.records {
		if doc.ExpiresAt != nil && !doc.ExpiresAt.After(now) {
			continue
		}
		if !includeRetired && doc.RetiredAt != nil {
			continue
		}
		if !scopeMatch(doc, execScope, searchScope) {
			continue
		}
		if typeFilter != nil && doc.Type != *typeFilter {
			continue
		}
		cp := *doc
		out = append(out, cp)
	}
	return out, nil
}

func scopeMatch(doc *memory.MemoryDocument, exec runtimectx.MemoryScope, searchScope string) bool {
	switch searchScope {
	case memory.ScopeThread:
		return doc.Scope == memory.ScopeThread && doc.UserID == exec.UserID && doc.AgentID == exec.AgentID && doc.ThreadID == exec.ThreadID
	case memory.ScopeAgent:
		return (doc.Scope == memory.ScopeAgent && doc.UserID == exec.UserID && doc.AgentID == exec.AgentID) ||
			(doc.Scope == memory.ScopeThread && doc.UserID == exec.UserID && doc.AgentID == exec.AgentID && doc.ThreadID == exec.ThreadID)
	case memory.ScopeUser:
		return (doc.Scope == memory.ScopeUser && doc.UserID == exec.UserID) ||
			(doc.Scope == memory.ScopeAgent && doc.UserID == exec.UserID && doc.AgentID == exec.AgentID) ||
			(doc.Scope == memory.ScopeThread && doc.UserID == exec.UserID && doc.AgentID == exec.AgentID && doc.ThreadID == exec.ThreadID)
	default:
		return false
	}
}

func (f *fakeMetaStore) StampRead(_ context.Context, doc memory.MemoryDocument) error {
	if f.stampErr != nil {
		return f.stampErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, ok := f.records[doc.LineageKey]; ok {
		now := time.Now().UTC()
		existing.LastReadAt = &now
	}
	return nil
}

func (f *fakeMetaStore) FindExpired(_ context.Context, now time.Time) ([]memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []memory.MemoryDocument
	for _, doc := range f.records {
		if doc.ExpiresAt != nil && !doc.ExpiresAt.After(now) {
			cp := *doc
			out = append(out, cp)
		}
	}
	return out, nil
}

func (f *fakeMetaStore) SoftDelete(_ context.Context, _, _, _ string) error { return nil }
func (f *fakeMetaStore) EnsureIndexes(_ context.Context) error              { return nil }

func newSvc(t *testing.T) (*memory.Service, string, *fakeMetaStore, *memory.InMemoryRevisionStore) {
	t.Helper()
	root := t.TempDir()
	meta := newFakeMeta()
	revisions := memory.NewInMemoryRevisionStore()
	svc := memory.NewService(memory.Config{Root: root}, meta, revisions)
	return svc, root, meta, revisions
}

func newSearchSvc(t *testing.T) (*memory.Service, *fakeMetaStore, *memory.InMemoryRevisionStore) {
	t.Helper()
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not in PATH - skipping search test")
	}
	meta := newFakeMeta()
	revisions := memory.NewInMemoryRevisionStore()
	svc := memory.NewService(memory.Config{Root: t.TempDir(), RGPath: "rg"}, meta, revisions)
	return svc, meta, revisions
}

func writeArgs(content, runID, toolCallID string) memory.MemoryWriteArgs {
	return memory.MemoryWriteArgs{
		Content:    content,
		Type:       memory.TypeFact,
		Scope:      memory.ScopeThread,
		Importance: 0.7,
		RunID:      runID,
		ToolCallID: toolCallID,
	}
}

func i(v int) *int { return &v }

func TestServiceWriteReadAndHistory(t *testing.T) {
	t.Parallel()
	svc, _, meta, _ := newSvc(t)
	scope := validScope()

	wr, err := svc.Write(context.Background(), scope, "mem-rt", writeArgs("hello world", "run-1", "call-1"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if wr.Revision != 1 {
		t.Fatalf("revision = %d, want 1", wr.Revision)
	}

	read, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{MemoryID: "mem-rt", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Content != "hello world" || read.Revision != 1 {
		t.Fatalf("read = (%q, rev %d), want hello world rev 1", read.Content, read.Revision)
	}

	lineage, _ := memory.LineageKey(scope, memory.ScopeThread, "mem-rt")
	if meta.records[lineage].LastReadAt == nil {
		t.Fatal("latest read should stamp last_read_at")
	}

	history, err := svc.History(context.Background(), scope, memory.MemoryHistoryArgs{MemoryID: "mem-rt", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(history.Revisions) != 1 || history.Revisions[0].Operation != memory.OperationCreate {
		t.Fatalf("history = %+v, want one create revision", history.Revisions)
	}
}

func TestServiceCreateRejectsExistingLineage(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "same-id", writeArgs("v1", "run-1", "call-1")); err != nil {
		t.Fatalf("first Write: %v", err)
	}
	_, err := svc.Write(context.Background(), scope, "same-id", writeArgs("v2", "run-2", "call-2"))
	if !errors.Is(err, memory.ErrMemoryExists) {
		t.Fatalf("expected ErrMemoryExists, got %v", err)
	}
	if !strings.Contains(err.Error(), "memory_patch or memory_update") {
		t.Fatalf("active collision should guide patch/update, got %v", err)
	}

	if _, err := svc.Retire(context.Background(), scope, memory.MemoryRetireArgs{
		MemoryID: "same-id", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "retire",
		RunID: "run-3", ToolCallID: "retire-1",
	}); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	_, err = svc.Write(context.Background(), scope, "same-id", writeArgs("v3", "run-4", "call-4"))
	if !errors.Is(err, memory.ErrMemoryExists) {
		t.Fatalf("expected ErrMemoryExists for retired collision, got %v", err)
	}
	if !strings.Contains(err.Error(), "memory_restore") {
		t.Fatalf("retired collision should guide restore, got %v", err)
	}
}

func TestServiceMutationReplayAfterHeadMoved(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "mem", writeArgs("alpha beta", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	patch := memory.MemoryPatchArgs{
		MemoryID: "mem", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "rename",
		Edits: []memory.MemoryPatchEdit{{OldText: "beta", NewText: "gamma"}},
		RunID: "run-1", ToolCallID: "patch-1",
	}
	first, err := svc.Patch(context.Background(), scope, patch)
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if _, err := svc.Update(context.Background(), scope, memory.MemoryUpdateArgs{
		MemoryID: "mem", Scope: memory.ScopeThread, ExpectedRevision: i(2), Reason: "replace",
		Content: "delta", RunID: "run-2", ToolCallID: "update-1",
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	replay, err := svc.Patch(context.Background(), scope, patch)
	if err != nil {
		t.Fatalf("Patch replay: %v", err)
	}
	if replay.Revision != first.Revision {
		t.Fatalf("replay revision = %d, want %d", replay.Revision, first.Revision)
	}
}

func TestServiceGeneratedIDsAreRunNamespaced(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()

	a, err := svc.Write(context.Background(), scope, "", writeArgs("first", "run-A", "same-call"))
	if err != nil {
		t.Fatalf("Write A: %v", err)
	}
	b, err := svc.Write(context.Background(), scope, "", writeArgs("second", "run-B", "same-call"))
	if err != nil {
		t.Fatalf("Write B: %v", err)
	}
	if a.MemoryID == b.MemoryID {
		t.Fatalf("generated IDs should differ across runs, both %q", a.MemoryID)
	}
}

func TestServiceCrossThreadSameSlugCoexists(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	threadA := validScope()
	threadB := runtimectx.MemoryScope{UserID: "user-1", AgentID: "agent-1", ThreadID: "thread-2"}

	if _, err := svc.Write(context.Background(), threadA, "slug", writeArgs("thread A", "run-A", "call-A")); err != nil {
		t.Fatalf("Write A: %v", err)
	}
	if _, err := svc.Write(context.Background(), threadB, "slug", writeArgs("thread B", "run-B", "call-B")); err != nil {
		t.Fatalf("Write B: %v", err)
	}
	readA, err := svc.Read(context.Background(), threadA, memory.MemoryReadArgs{MemoryID: "slug", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("Read A: %v", err)
	}
	readB, err := svc.Read(context.Background(), threadB, memory.MemoryReadArgs{MemoryID: "slug", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("Read B: %v", err)
	}
	if readA.Content != "thread A" || readB.Content != "thread B" {
		t.Fatalf("cross-thread content = %q/%q", readA.Content, readB.Content)
	}
}

func TestServicePatchValidationAllOrNothing(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "patchy", writeArgs("abcd abcd", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_, err := svc.Patch(context.Background(), scope, memory.MemoryPatchArgs{
		MemoryID: "patchy", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "ambiguous",
		Edits: []memory.MemoryPatchEdit{{OldText: "abcd", NewText: "wxyz"}},
		RunID: "run-1", ToolCallID: "patch-ambiguous",
	})
	if !errors.Is(err, memory.ErrInvalidDocument) {
		t.Fatalf("expected ErrInvalidDocument for ambiguous patch, got %v", err)
	}
	read, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{MemoryID: "patchy", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Content != "abcd abcd" || read.Revision != 1 {
		t.Fatalf("failed patch should not mutate, got content %q rev %d", read.Content, read.Revision)
	}

	if _, err := svc.Write(context.Background(), scope, "overlap", writeArgs("abcd", "run-2", "call-2")); err != nil {
		t.Fatalf("Write overlap: %v", err)
	}
	_, err = svc.Patch(context.Background(), scope, memory.MemoryPatchArgs{
		MemoryID: "overlap", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "overlap",
		Edits: []memory.MemoryPatchEdit{
			{OldText: "abc", NewText: "x"},
			{OldText: "bc", NewText: "y"},
		},
		RunID: "run-2", ToolCallID: "patch-overlap",
	})
	if !errors.Is(err, memory.ErrInvalidDocument) {
		t.Fatalf("expected ErrInvalidDocument for overlap, got %v", err)
	}

	if _, err := svc.Write(context.Background(), scope, "self-overlap", writeArgs("aaa", "run-3", "call-3")); err != nil {
		t.Fatalf("Write self-overlap: %v", err)
	}
	_, err = svc.Patch(context.Background(), scope, memory.MemoryPatchArgs{
		MemoryID: "self-overlap", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "self overlap",
		Edits: []memory.MemoryPatchEdit{{OldText: "aa", NewText: "b"}},
		RunID: "run-3", ToolCallID: "patch-self-overlap",
	})
	if !errors.Is(err, memory.ErrInvalidDocument) {
		t.Fatalf("expected ErrInvalidDocument for self-overlap ambiguity, got %v", err)
	}
}

func TestServiceUpdateRetireRestoreFlow(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "flow", writeArgs("v1", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := svc.Update(context.Background(), scope, memory.MemoryUpdateArgs{
		MemoryID: "flow", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "whole body",
		Content: "v2", RunID: "run-1", ToolCallID: "update-1",
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	retired, err := svc.Retire(context.Background(), scope, memory.MemoryRetireArgs{
		MemoryID: "flow", Scope: memory.ScopeThread, ExpectedRevision: i(2), Reason: "obsolete",
		RunID: "run-1", ToolCallID: "retire-1",
	})
	if err != nil {
		t.Fatalf("Retire: %v", err)
	}
	if !retired.Retired || retired.Revision != 3 {
		t.Fatalf("retire result = %+v", retired)
	}
	if _, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{MemoryID: "flow", Scope: memory.ScopeThread}); !errors.Is(err, memory.ErrRetiredMemory) {
		t.Fatalf("latest read should see retired memory, got %v", err)
	}
	historical, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{MemoryID: "flow", Scope: memory.ScopeThread, Revision: i(3)})
	if err != nil {
		t.Fatalf("historical retired read: %v", err)
	}
	if historical.Content != "v2" || !historical.Retired {
		t.Fatalf("historical retired read = %+v", historical)
	}
	restore, err := svc.Restore(context.Background(), scope, memory.MemoryRestoreArgs{
		MemoryID: "flow", Scope: memory.ScopeThread, ExpectedRevision: i(3), Reason: "restore default",
		RunID: "run-1", ToolCallID: "restore-1",
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restore.Revision != 4 || restore.Retired {
		t.Fatalf("restore result = %+v", restore)
	}
	read, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{MemoryID: "flow", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("read restored: %v", err)
	}
	if read.Content != "v2" || read.Revision != 4 {
		t.Fatalf("restored read = %+v", read)
	}
}

func TestServiceRestoreActiveWithoutFromRevisionFails(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "active", writeArgs("v1", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_, err := svc.Restore(context.Background(), scope, memory.MemoryRestoreArgs{
		MemoryID: "active", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "bad restore",
		RunID: "run-1", ToolCallID: "restore-active",
	})
	if !errors.Is(err, memory.ErrInvalidDocument) {
		t.Fatalf("expected ErrInvalidDocument, got %v", err)
	}
}

func TestServiceMissingExpectedRevisionFails(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "exp", writeArgs("v1", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_, err := svc.Update(context.Background(), scope, memory.MemoryUpdateArgs{
		MemoryID: "exp", Scope: memory.ScopeThread, Reason: "missing", Content: "v2",
		RunID: "run-1", ToolCallID: "update-missing",
	})
	if !errors.Is(err, memory.ErrExpectedRevisionRequired) {
		t.Fatalf("expected ErrExpectedRevisionRequired, got %v", err)
	}
}

func TestServiceSearchHidesRetiredUnlessRequested(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSearchSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "search-retired", writeArgs("needle body", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := svc.Retire(context.Background(), scope, memory.MemoryRetireArgs{
		MemoryID: "search-retired", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "hide",
		RunID: "run-1", ToolCallID: "retire-1",
	}); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	activeOnly, err := svc.Search(context.Background(), scope, memory.MemorySearchArgs{Pattern: "needle", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("Search active: %v", err)
	}
	if len(activeOnly.Results) != 0 {
		t.Fatalf("expected retired memory hidden, got %+v", activeOnly.Results)
	}
	withRetired, err := svc.Search(context.Background(), scope, memory.MemorySearchArgs{Pattern: "needle", Scope: memory.ScopeThread, IncludeRetired: true})
	if err != nil {
		t.Fatalf("Search retired: %v", err)
	}
	if len(withRetired.Results) != 1 || !withRetired.Results[0].Retired || withRetired.Results[0].Revision != 2 {
		t.Fatalf("retired search results = %+v", withRetired.Results)
	}
}

func TestServiceBlobDedupeSearchReturnsAllMemories(t *testing.T) {
	t.Parallel()
	svc, _, _ := newSearchSvc(t)
	scope := validScope()
	for idx, id := range []string{"same-1", "same-2"} {
		if _, err := svc.Write(context.Background(), scope, id, writeArgs("shared needle body", fmt.Sprintf("run-%d", idx), fmt.Sprintf("call-%d", idx))); err != nil {
			t.Fatalf("Write %s: %v", id, err)
		}
	}
	resp, err := svc.Search(context.Background(), scope, memory.MemorySearchArgs{Pattern: "needle", Scope: memory.ScopeThread})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("expected both deduped blob memories, got %+v", resp.Results)
	}
}

func TestServiceConcurrentPatchOneWins(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "race", writeArgs("hello world", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for n := 0; n < 2; n++ {
		n := n
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.Patch(context.Background(), scope, memory.MemoryPatchArgs{
				MemoryID: "race", Scope: memory.ScopeThread, ExpectedRevision: i(1), Reason: "race",
				Edits: []memory.MemoryPatchEdit{{OldText: "world", NewText: fmt.Sprintf("world-%d", n)}},
				RunID: "run-race", ToolCallID: fmt.Sprintf("patch-%d", n),
			})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	successes := 0
	conflicts := 0
	for err := range errs {
		if err == nil {
			successes++
		} else if errors.Is(err, memory.ErrRevisionConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success/conflict = %d/%d, want 1/1", successes, conflicts)
	}
}

func TestCleanupWorkerNoopsForVersionedMemories(t *testing.T) {
	t.Parallel()
	svc, _, meta, _ := newSvc(t)
	scope := validScope()
	if _, err := svc.Write(context.Background(), scope, "cleanup", writeArgs("keep projection", "run-1", "call-1")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc.StartCleanupWorker(ctx, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	lineage, _ := memory.LineageKey(scope, memory.ScopeThread, "cleanup")
	if meta.records[lineage] == nil {
		t.Fatal("cleanup worker should not delete projection rows")
	}
}
