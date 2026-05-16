package memory_test

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"testing"
	"time"

	"backend/memory"
	"backend/runtimectx"
)

// newSvc creates a Service with a fresh temp root, bypassing ValidateStartup.
// Suitable for Write and Read tests — does not require rg.
func newSvc(t *testing.T) (*memory.Service, string) {
	t.Helper()
	root := t.TempDir()
	return memory.NewService(memory.Config{Root: root}), root
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

// writeExpiredDoc plants a document with a past ExpiresAt directly on disk,
// bypassing the Service (which would skip overwriting a non-expired doc).
func writeExpiredDoc(t *testing.T, root string, scope runtimectx.MemoryScope, memID string) {
	t.Helper()
	past := time.Now().UTC().Add(-48 * time.Hour)
	expiresAt := time.Now().UTC().Add(-1 * time.Hour)
	doc := memory.MemoryDocument{
		Version:    memory.DocumentVersion,
		ID:         memID,
		Type:       memory.TypeFact,
		Scope:      memory.ScopeThread,
		AgentID:    scope.AgentID,
		ThreadID:   scope.ThreadID,
		Importance: 0.5,
		CreatedAt:  past,
		ExpiresAt:  &expiresAt,
		Body:       "expired content",
	}
	rendered, err := memory.Render(doc)
	if err != nil {
		t.Fatalf("Render expired doc: %v", err)
	}
	path, err := memory.ResolveWritePath(root, scope, memory.ScopeThread, memID)
	if err != nil {
		t.Fatalf("ResolveWritePath: %v", err)
	}
	if err := memory.WriteFileAtomic(path, rendered); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
}

// newSearchSvc creates a Service with rg wired in; skips the test if rg is not
// available in PATH.
func newSearchSvc(t *testing.T) (*memory.Service, string) {
	t.Helper()
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not in PATH — skipping search test")
	}
	root := t.TempDir()
	return memory.NewService(memory.Config{Root: root, RGPath: "rg"}), root
}

// ── Write ─────────────────────────────────────────────────────────────────────

func TestServiceWriteRoundTrip(t *testing.T) {
	t.Parallel()
	svc, _ := newSvc(t)

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

func TestServiceWriteIsIdempotent(t *testing.T) {
	t.Parallel()
	svc, _ := newSvc(t)
	scope := validScope()

	r1, err := svc.Write(context.Background(), scope, "mem-idem", svcWriteArgs("first write"))
	if err != nil {
		t.Fatalf("first Write: %v", err)
	}
	// Second write with the same ID and different content — must return the
	// original result without overwriting.
	r2, err := svc.Write(context.Background(), scope, "mem-idem", svcWriteArgs("second write"))
	if err != nil {
		t.Fatalf("second Write: %v", err)
	}
	if r1.CreatedAt != r2.CreatedAt {
		t.Errorf("idempotent write changed CreatedAt: %q → %q", r1.CreatedAt, r2.CreatedAt)
	}
}

func TestServiceWriteOverwritesExpiredDoc(t *testing.T) {
	t.Parallel()
	svc, root := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-exp")

	// Service.Write must overwrite the expired document.
	result, err := svc.Write(context.Background(), scope, "mem-exp", svcWriteArgs("fresh content"))
	if err != nil {
		t.Fatalf("Write over expired doc: %v", err)
	}
	if result.MemoryID != "mem-exp" {
		t.Errorf("MemoryID: got %q, want %q", result.MemoryID, "mem-exp")
	}

	// Confirm new content is on disk.
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
	svc, _ := newSvc(t)
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
	svc, _ := newSvc(t)
	_, err := svc.Write(context.Background(), validScope(), "mem-empty", svcWriteArgs(""))
	if err == nil {
		t.Fatal("expected error for empty content")
	}
}

func TestServiceWriteRejectsInvalidType(t *testing.T) {
	t.Parallel()
	svc, _ := newSvc(t)
	args := svcWriteArgs("some content")
	args.Type = "not-a-type"
	_, err := svc.Write(context.Background(), validScope(), "mem-badtype", args)
	if !errors.Is(err, memory.ErrInvalidType) {
		t.Fatalf("expected ErrInvalidType, got: %v", err)
	}
}

func TestServiceWriteRejectsInvalidScope(t *testing.T) {
	t.Parallel()
	svc, _ := newSvc(t)
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
	svc, _ := newSvc(t)
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
	svc, _ := newSvc(t)
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
	svc, root := newSvc(t)
	scope := validScope()

	writeExpiredDoc(t, root, scope, "mem-readexp")

	_, err := svc.Read(context.Background(), scope, memory.MemoryReadArgs{
		MemoryID: "mem-readexp",
		Scope:    memory.ScopeThread,
	})
	if !errors.Is(err, memory.ErrExpiredMemory) {
		t.Fatalf("expected ErrExpiredMemory, got: %v", err)
	}
}

// ── Search ────────────────────────────────────────────────────────────────────

func TestServiceSearchFindsMatch(t *testing.T) {
	t.Parallel()
	svc, _ := newSearchSvc(t)
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
	svc, _ := newSearchSvc(t)
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

func TestServiceSearchRespectsLimit(t *testing.T) {
	t.Parallel()
	svc, _ := newSearchSvc(t)
	scope := validScope()

	// Write 3 docs all containing the search term.
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
