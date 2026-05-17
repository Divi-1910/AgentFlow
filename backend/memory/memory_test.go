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

// ── ResolveWritePath ──────────────────────────────────────────────────────────

func TestResolveWritePathThreadScope(t *testing.T) {
	t.Parallel()
	scope := validScope()
	path, err := memory.ResolveWritePath("/root", scope, memory.ScopeThread, "mem-1")
	if err != nil {
		t.Fatalf("ResolveWritePath: %v", err)
	}
	want := filepath.Join("/root", "user-1", memory.ScopeThread, "thread-1", "mem-1.md")
	if path != want {
		t.Errorf("got %q, want %q", path, want)
	}
}

func TestResolveWritePathAgentScope(t *testing.T) {
	t.Parallel()
	scope := validScope()
	path, err := memory.ResolveWritePath("/root", scope, memory.ScopeAgent, "mem-1")
	if err != nil {
		t.Fatalf("ResolveWritePath: %v", err)
	}
	want := filepath.Join("/root", "user-1", memory.ScopeAgent, "agent-1", "mem-1.md")
	if path != want {
		t.Errorf("got %q, want %q", path, want)
	}
}

func TestResolveWritePathUserScope(t *testing.T) {
	t.Parallel()
	scope := validScope()
	path, err := memory.ResolveWritePath("/root", scope, memory.ScopeUser, "mem-1")
	if err != nil {
		t.Fatalf("ResolveWritePath: %v", err)
	}
	want := filepath.Join("/root", "user-1", memory.ScopeUser, "mem-1.md")
	if path != want {
		t.Errorf("got %q, want %q", path, want)
	}
}

func TestResolveWritePathInvalidScope(t *testing.T) {
	t.Parallel()
	_, err := memory.ResolveWritePath("/root", validScope(), "badscope", "mem-1")
	if err == nil {
		t.Error("expected error for invalid scope")
	}
}

func TestResolveWritePathRejectsPathTraversalInMemoryID(t *testing.T) {
	t.Parallel()
	_, err := memory.ResolveWritePath("/root", validScope(), memory.ScopeThread, "../escape")
	if err == nil {
		t.Error("expected error for path-traversal memory ID")
	}
}

func TestResolveWritePathRejectsEmptyUserID(t *testing.T) {
	t.Parallel()
	scope := runtimectx.MemoryScope{UserID: "", AgentID: "agent-1", ThreadID: "thread-1"}
	_, err := memory.ResolveWritePath("/root", scope, memory.ScopeThread, "mem-1")
	if err == nil {
		t.Error("expected error for empty user_id")
	}
}

// ── validateSegment hardening ─────────────────────────────────────────────────

func TestResolveWritePathRejectsOversizedMemoryID(t *testing.T) {
	t.Parallel()
	oversized := strings.Repeat("a", memory.MaxSegmentLen+1)
	_, err := memory.ResolveWritePath("/root", validScope(), memory.ScopeThread, oversized)
	if err == nil {
		t.Errorf("expected error for memory_id of length %d (max %d)", len(oversized), memory.MaxSegmentLen)
	}
}

func TestResolveWritePathRejectsControlCharInMemoryID(t *testing.T) {
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
			_, err := memory.ResolveWritePath("/root", validScope(), memory.ScopeThread, tc.value)
			if err == nil {
				t.Errorf("expected error for memory_id with %s", tc.name)
			}
		})
	}
}
