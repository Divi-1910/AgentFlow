package memory_test

import (
	"path/filepath"
	"strings"
	"testing"

	"backend/memory"
	"backend/runtimectx"
)

func validScope() runtimectx.MemoryScope {
	return runtimectx.MemoryScope{UserID: "user-1", AgentID: "agent-1", ThreadID: "thread-1"}
}

func validRevision(scopeName string) memory.MemoryRevision {
	scope := validScope()
	return memory.MemoryRevision{
		UserID:   scope.UserID,
		AgentID:  scope.AgentID,
		ThreadID: scope.ThreadID,
		MemoryID: "mem-1",
		Scope:    scopeName,
		Revision: 2,
	}
}

// ── RevisionBodyRelPath ───────────────────────────────────────────────────────

func TestRevisionBodyRelPathThreadScope(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeThread)
	path, err := memory.RevisionBodyPath("/root", rev)
	if err != nil {
		t.Fatalf("RevisionBodyPath: %v", err)
	}
	want := filepath.Join("/root", "user-1", "memories", memory.ScopeThread, "agent-1", "thread-1", "mem-1", "mem-1_rev-2.md")
	if path != want {
		t.Errorf("got %q, want %q", path, want)
	}
}

func TestRevisionBodyRelPathAgentScope(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeAgent)
	path, err := memory.RevisionBodyPath("/root", rev)
	if err != nil {
		t.Fatalf("RevisionBodyPath: %v", err)
	}
	want := filepath.Join("/root", "user-1", "memories", memory.ScopeAgent, "agent-1", "mem-1", "mem-1_rev-2.md")
	if path != want {
		t.Errorf("got %q, want %q", path, want)
	}
}

func TestRevisionBodyRelPathUserScope(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeUser)
	path, err := memory.RevisionBodyPath("/root", rev)
	if err != nil {
		t.Fatalf("RevisionBodyPath: %v", err)
	}
	want := filepath.Join("/root", "user-1", "memories", memory.ScopeUser, "mem-1", "mem-1_rev-2.md")
	if path != want {
		t.Errorf("got %q, want %q", path, want)
	}
}

func TestRevisionBodyRelPathInvalidScope(t *testing.T) {
	t.Parallel()
	rev := validRevision("badscope")
	_, err := memory.RevisionBodyRelPath(rev)
	if err == nil {
		t.Error("expected error for invalid scope")
	}
}

func TestRevisionBodyRelPathRejectsPathTraversalInMemoryID(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeThread)
	rev.MemoryID = "../escape"
	_, err := memory.RevisionBodyRelPath(rev)
	if err == nil {
		t.Error("expected error for path-traversal memory ID")
	}
}

func TestRevisionBodyRelPathRejectsEmptyUserID(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeThread)
	rev.UserID = ""
	_, err := memory.RevisionBodyRelPath(rev)
	if err == nil {
		t.Error("expected error for empty user_id")
	}
}

func TestRevisionBodyRelPathRejectsMissingAgentForAgentScope(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeAgent)
	rev.AgentID = ""
	_, err := memory.RevisionBodyRelPath(rev)
	if err == nil {
		t.Error("expected error for empty agent_id")
	}
}

func TestRevisionBodyRelPathRejectsNonPositiveRevision(t *testing.T) {
	t.Parallel()
	rev := validRevision(memory.ScopeThread)
	rev.Revision = 0
	_, err := memory.RevisionBodyRelPath(rev)
	if err == nil {
		t.Error("expected error for non-positive revision")
	}
}

// ── validateSegment hardening ─────────────────────────────────────────────────

func TestRevisionBodyRelPathRejectsOversizedMemoryID(t *testing.T) {
	t.Parallel()
	oversized := strings.Repeat("a", memory.MaxSegmentLen+1)
	rev := validRevision(memory.ScopeThread)
	rev.MemoryID = oversized
	_, err := memory.RevisionBodyRelPath(rev)
	if err == nil {
		t.Errorf("expected error for memory_id of length %d (max %d)", len(oversized), memory.MaxSegmentLen)
	}
}

func TestRevisionBodyRelPathRejectsControlCharInMemoryID(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		value string
	}{
		{"null byte", "mem\x00id"},
		{"tab", "mem\tid"},
		{"newline", "mem\nid"},
		{"DEL", "mem\x7fid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rev := validRevision(memory.ScopeThread)
			rev.MemoryID = tc.value
			_, err := memory.RevisionBodyRelPath(rev)
			if err == nil {
				t.Errorf("expected error for memory_id with %s", tc.name)
			}
		})
	}
}
