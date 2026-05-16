package memory_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"backend/memory"
	"backend/runtimectx"
)

// ── helpers ───────────────────────────────────────────────────────────────────

var fixedTime = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
var laterTime = fixedTime.Add(24 * time.Hour)

func validDocBytes(overrides map[string]string) []byte {
	fields := map[string]string{
		"version":    "1",
		"id":         "mem-abc123",
		"type":       "fact",
		"scope":      "thread",
		"agent_id":   "agent-1",
		"thread_id":  "thread-1",
		"importance": "0.80",
		"created_at": fixedTime.Format(time.RFC3339),
	}
	for k, v := range overrides {
		fields[k] = v
	}
	var sb strings.Builder
	sb.WriteString("---\n")
	// Write in a consistent order matching required fields + any extras.
	order := []string{"version", "id", "type", "scope", "agent_id", "thread_id", "importance", "created_at", "expires_at"}
	written := map[string]bool{}
	for _, k := range order {
		if v, ok := fields[k]; ok {
			sb.WriteString(k + ": " + v + "\n")
			written[k] = true
		}
	}
	// Any extra override keys not in the standard order.
	for k, v := range fields {
		if !written[k] {
			sb.WriteString(k + ": " + v + "\n")
		}
	}
	sb.WriteString("---\n\nThis is the memory body.\n")
	return []byte(sb.String())
}

func validDoc() memory.MemoryDocument {
	return memory.MemoryDocument{
		Version:   1,
		ID:        "mem-abc123",
		Type:      memory.TypeFact,
		Scope:     memory.ScopeThread,
		AgentID:   "agent-1",
		ThreadID:  "thread-1",
		Importance: 0.8,
		CreatedAt: fixedTime,
		Body:      "This is the memory body.",
	}
}

func validScope() runtimectx.MemoryScope {
	return runtimectx.MemoryScope{UserID: "user-1", AgentID: "agent-1", ThreadID: "thread-1"}
}

// ── Parse ─────────────────────────────────────────────────────────────────────

func TestParseValidDocument(t *testing.T) {
	t.Parallel()
	doc, err := memory.Parse(validDocBytes(nil))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if doc.ID != "mem-abc123" {
		t.Errorf("ID: got %q, want %q", doc.ID, "mem-abc123")
	}
	if doc.Type != memory.TypeFact {
		t.Errorf("Type: got %q, want %q", doc.Type, memory.TypeFact)
	}
	if doc.Scope != memory.ScopeThread {
		t.Errorf("Scope: got %q, want %q", doc.Scope, memory.ScopeThread)
	}
	if doc.Importance != 0.80 {
		t.Errorf("Importance: got %f, want 0.80", doc.Importance)
	}
	if doc.Body != "This is the memory body." {
		t.Errorf("Body: got %q", doc.Body)
	}
}

func TestParseValidDocumentWithExpiresAt(t *testing.T) {
	t.Parallel()
	raw := validDocBytes(map[string]string{
		"expires_at": laterTime.Format(time.RFC3339),
	})
	doc, err := memory.Parse(raw)
	if err != nil {
		t.Fatalf("Parse with expires_at: %v", err)
	}
	if doc.ExpiresAt == nil {
		t.Fatal("expected ExpiresAt to be set")
	}
	if !doc.ExpiresAt.Equal(laterTime) {
		t.Errorf("ExpiresAt: got %v, want %v", doc.ExpiresAt, laterTime)
	}
}

func TestParseMissingFrontmatterStart(t *testing.T) {
	t.Parallel()
	raw := []byte("no frontmatter here\n\nbody text")
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for missing frontmatter start")
	}
}

func TestParseMissingFrontmatterEnd(t *testing.T) {
	t.Parallel()
	raw := []byte("---\nversion: 1\n\nbody without closing ---")
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for missing frontmatter end")
	}
}

func TestParseMalformedFrontmatterLine(t *testing.T) {
	t.Parallel()
	raw := []byte("---\nno-colon-here\n---\n\nbody")
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for malformed frontmatter line")
	}
}

func TestParseDuplicateFrontmatterKey(t *testing.T) {
	t.Parallel()
	raw := []byte("---\nversion: 1\nversion: 2\n---\n\nbody")
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for duplicate key")
	}
}

func TestParseMissingRequiredField(t *testing.T) {
	t.Parallel()
	required := []string{"version", "id", "type", "scope", "agent_id", "thread_id", "importance", "created_at"}
	for _, field := range required {
		overrides := map[string]string{field: ""}
		// Remove the field entirely by writing raw bytes without it.
		raw := validDocBytes(nil)
		// Blank override won't work — build manually without that field.
		var sb strings.Builder
		sb.WriteString("---\n")
		for _, f := range required {
			if f == field {
				continue
			}
			defaults := map[string]string{
				"version": "1", "id": "mem-abc123", "type": "fact",
				"scope": "thread", "agent_id": "agent-1", "thread_id": "thread-1",
				"importance": "0.8", "created_at": fixedTime.Format(time.RFC3339),
			}
			sb.WriteString(f + ": " + defaults[f] + "\n")
		}
		_ = overrides
		_ = raw
		sb.WriteString("---\n\nbody\n")
		_, err := memory.Parse([]byte(sb.String()))
		if err == nil {
			t.Errorf("field %q: expected error for missing required field", field)
		}
	}
}

func TestParseInvalidType(t *testing.T) {
	t.Parallel()
	raw := validDocBytes(map[string]string{"type": "invalid-type"})
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for invalid type")
	}
}

func TestParseInvalidScope(t *testing.T) {
	t.Parallel()
	raw := validDocBytes(map[string]string{"scope": "invalid-scope"})
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for invalid scope")
	}
}

func TestParseImportanceOutOfRange(t *testing.T) {
	t.Parallel()
	cases := []string{"-0.1", "1.1", "2.0"}
	for _, v := range cases {
		raw := validDocBytes(map[string]string{"importance": v})
		_, err := memory.Parse(raw)
		if err == nil {
			t.Errorf("importance %s: expected error for out-of-range value", v)
		}
	}
}

func TestParseInvalidCreatedAt(t *testing.T) {
	t.Parallel()
	raw := validDocBytes(map[string]string{"created_at": "not-a-date"})
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for invalid created_at")
	}
}

func TestParseExpiresAtBeforeCreatedAt(t *testing.T) {
	t.Parallel()
	raw := validDocBytes(map[string]string{
		"created_at": laterTime.Format(time.RFC3339),
		"expires_at": fixedTime.Format(time.RFC3339), // earlier than created_at
	})
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error when expires_at is before created_at")
	}
}

func TestParseEmptyBody(t *testing.T) {
	t.Parallel()
	raw := []byte("---\nversion: 1\nid: x\ntype: fact\nscope: thread\nagent_id: a\nthread_id: t\nimportance: 0.5\ncreated_at: " +
		fixedTime.Format(time.RFC3339) + "\n---\n")
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for empty body")
	}
}

func TestParseUnsupportedVersion(t *testing.T) {
	t.Parallel()
	raw := validDocBytes(map[string]string{"version": "99"})
	_, err := memory.Parse(raw)
	if err == nil {
		t.Error("expected error for unsupported version")
	}
}

// ── Render ────────────────────────────────────────────────────────────────────

func TestRenderValidDocument(t *testing.T) {
	t.Parallel()
	doc := validDoc()
	out, err := memory.Render(doc)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.HasPrefix(out, "---\n") {
		t.Error("rendered output should start with frontmatter delimiter")
	}
	if !strings.Contains(out, "id: mem-abc123") {
		t.Error("rendered output should contain ID")
	}
	if !strings.Contains(out, doc.Body) {
		t.Error("rendered output should contain body")
	}
}

func TestRenderEmptyBody(t *testing.T) {
	t.Parallel()
	doc := validDoc()
	doc.Body = ""
	_, err := memory.Render(doc)
	if err == nil {
		t.Error("expected error for empty body")
	}
}

func TestRenderInvalidScope(t *testing.T) {
	t.Parallel()
	doc := validDoc()
	doc.Scope = "bad-scope"
	_, err := memory.Render(doc)
	if err == nil {
		t.Error("expected error for invalid scope")
	}
}

func TestRenderInvalidType(t *testing.T) {
	t.Parallel()
	doc := validDoc()
	doc.Type = "bad-type"
	_, err := memory.Render(doc)
	if err == nil {
		t.Error("expected error for invalid type")
	}
}

func TestRenderParseRoundTrip(t *testing.T) {
	t.Parallel()
	original := validDoc()
	rendered, err := memory.Render(original)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	parsed, err := memory.Parse([]byte(rendered))
	if err != nil {
		t.Fatalf("Parse after Render: %v", err)
	}
	if parsed.ID != original.ID {
		t.Errorf("ID: got %q, want %q", parsed.ID, original.ID)
	}
	if parsed.Body != original.Body {
		t.Errorf("Body: got %q, want %q", parsed.Body, original.Body)
	}
	if parsed.Importance != original.Importance {
		t.Errorf("Importance: got %f, want %f", parsed.Importance, original.Importance)
	}
}

func TestRenderIncludesExpiresAt(t *testing.T) {
	t.Parallel()
	doc := validDoc()
	doc.ExpiresAt = &laterTime
	out, err := memory.Render(doc)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(out, "expires_at:") {
		t.Error("rendered output should include expires_at when set")
	}
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

// ── ResolveSearchRoots ────────────────────────────────────────────────────────

func TestResolveSearchRootsThreadScope(t *testing.T) {
	t.Parallel()
	roots, err := memory.ResolveSearchRoots("/root", validScope(), memory.ScopeThread)
	if err != nil {
		t.Fatalf("ResolveSearchRoots: %v", err)
	}
	if len(roots) != 1 {
		t.Errorf("thread scope: expected 1 root, got %d", len(roots))
	}
}

func TestResolveSearchRootsAgentScopeIncludesThread(t *testing.T) {
	t.Parallel()
	roots, err := memory.ResolveSearchRoots("/root", validScope(), memory.ScopeAgent)
	if err != nil {
		t.Fatalf("ResolveSearchRoots: %v", err)
	}
	if len(roots) != 2 {
		t.Errorf("agent scope: expected 2 roots, got %d", len(roots))
	}
}

func TestResolveSearchRootsUserScopeIncludesAll(t *testing.T) {
	t.Parallel()
	roots, err := memory.ResolveSearchRoots("/root", validScope(), memory.ScopeUser)
	if err != nil {
		t.Fatalf("ResolveSearchRoots: %v", err)
	}
	if len(roots) != 3 {
		t.Errorf("user scope: expected 3 roots, got %d", len(roots))
	}
}

func TestResolveSearchRootsInvalidScope(t *testing.T) {
	t.Parallel()
	_, err := memory.ResolveSearchRoots("/root", validScope(), "badscope")
	if err == nil {
		t.Error("expected error for invalid scope")
	}
}

// ── ValidateDocumentPath ──────────────────────────────────────────────────────

func TestValidateDocumentPathThreadValid(t *testing.T) {
	t.Parallel()
	root := "/root"
	doc := memory.MemoryDocument{ID: "mem-1", Scope: memory.ScopeThread, ThreadID: "thread-1"}
	path := filepath.Join(root, "user-1", memory.ScopeThread, "thread-1", "mem-1.md")
	if err := memory.ValidateDocumentPath(root, path, doc); err != nil {
		t.Errorf("expected valid thread path, got: %v", err)
	}
}

func TestValidateDocumentPathAgentValid(t *testing.T) {
	t.Parallel()
	root := "/root"
	doc := memory.MemoryDocument{ID: "mem-1", Scope: memory.ScopeAgent, AgentID: "agent-1"}
	path := filepath.Join(root, "user-1", memory.ScopeAgent, "agent-1", "mem-1.md")
	if err := memory.ValidateDocumentPath(root, path, doc); err != nil {
		t.Errorf("expected valid agent path, got: %v", err)
	}
}

func TestValidateDocumentPathUserValid(t *testing.T) {
	t.Parallel()
	root := "/root"
	doc := memory.MemoryDocument{ID: "mem-1", Scope: memory.ScopeUser}
	path := filepath.Join(root, "user-1", memory.ScopeUser, "mem-1.md")
	if err := memory.ValidateDocumentPath(root, path, doc); err != nil {
		t.Errorf("expected valid user path, got: %v", err)
	}
}

func TestValidateDocumentPathRejectsPathEscapingRoot(t *testing.T) {
	t.Parallel()
	root := "/root"
	doc := memory.MemoryDocument{ID: "mem-1", Scope: memory.ScopeThread, ThreadID: "thread-1"}
	path := "/other/user-1/thread/thread-1/mem-1.md"
	if err := memory.ValidateDocumentPath(root, path, doc); err == nil {
		t.Error("expected error for path escaping root")
	}
}

func TestValidateDocumentPathRejectsMismatchedID(t *testing.T) {
	t.Parallel()
	root := "/root"
	doc := memory.MemoryDocument{ID: "mem-correct", Scope: memory.ScopeThread, ThreadID: "thread-1"}
	path := filepath.Join(root, "user-1", memory.ScopeThread, "thread-1", "mem-wrong.md")
	if err := memory.ValidateDocumentPath(root, path, doc); err == nil {
		t.Error("expected error for mismatched file name and document ID")
	}
}
