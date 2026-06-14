package memory_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"backend/memory"
)

// ── EnsureDir ─────────────────────────────────────────────────────────────────

func TestEnsureDirCreatesDirectory(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dir := filepath.Join(root, "a", "b", "c")
	if err := memory.EnsureDir(dir); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat after EnsureDir: %v", err)
	}
	if !info.IsDir() {
		t.Error("expected a directory")
	}
}

func TestEnsureDirIsIdempotent(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "repeated")
	if err := memory.EnsureDir(dir); err != nil {
		t.Fatalf("first EnsureDir: %v", err)
	}
	if err := memory.EnsureDir(dir); err != nil {
		t.Fatalf("second EnsureDir: %v", err)
	}
}

// ── WriteFileAtomic ───────────────────────────────────────────────────────────

func TestWriteFileAtomicCreatesFile(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "out.md")
	if err := memory.WriteFileAtomic(path, "hello world"); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after write: %v", err)
	}
	if string(data) != "hello world" {
		t.Errorf("content: got %q, want %q", string(data), "hello world")
	}
}

func TestWriteFileAtomicCreatesParentDirs(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "deep", "nested", "file.md")
	if err := memory.WriteFileAtomic(path, "nested content"); err != nil {
		t.Fatalf("WriteFileAtomic with nested path: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not created: %v", err)
	}
}

// ── ReadFileLimited ───────────────────────────────────────────────────────────

func TestReadFileLimitedRoundTrip(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "read.md")
	content := "round trip content"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	data, err := memory.ReadFileLimited(path, len(content)+100)
	if err != nil {
		t.Fatalf("ReadFileLimited: %v", err)
	}
	if string(data) != content {
		t.Errorf("content: got %q, want %q", string(data), content)
	}
}

func TestReadFileLimitedReturnsErrMemoryNotFound(t *testing.T) {
	t.Parallel()
	_, err := memory.ReadFileLimited(filepath.Join(t.TempDir(), "nonexistent.md"), 1024)
	if !errors.Is(err, memory.ErrMemoryNotFound) {
		t.Fatalf("expected ErrMemoryNotFound, got: %v", err)
	}
}

func TestReadFileLimitedRejectsOversizedFile(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "big.md")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 200)), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	_, err := memory.ReadFileLimited(path, 100) // limit < file size
	if !errors.Is(err, memory.ErrInvalidDocument) {
		t.Fatalf("expected ErrInvalidDocument, got: %v", err)
	}
}

// ── Revision body helpers ────────────────────────────────────────────────────

func TestWritePendingFinalizeAndReadRevisionBody(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	rev := memory.MemoryRevision{
		UserID:     "user-1",
		AgentID:    "agent-1",
		ThreadID:   "thread-1",
		MemoryID:   "mem-1",
		Scope:      memory.ScopeThread,
		Revision:   1,
		MutationID: "run-1:call-1",
	}
	bodyPath, err := memory.RevisionBodyRelPath(rev)
	if err != nil {
		t.Fatalf("RevisionBodyRelPath: %v", err)
	}
	rev.BodyPath = bodyPath

	if err := memory.WritePendingRevisionBody(root, rev, "revision body"); err != nil {
		t.Fatalf("WritePendingRevisionBody: %v", err)
	}
	finalPath, err := memory.RevisionBodyPath(root, rev)
	if err != nil {
		t.Fatalf("RevisionBodyPath: %v", err)
	}
	if _, err := os.Stat(finalPath); !os.IsNotExist(err) {
		t.Fatalf("final file should not exist before finalize, stat err=%v", err)
	}
	if err := memory.FinalizeRevisionBody(root, rev); err != nil {
		t.Fatalf("FinalizeRevisionBody: %v", err)
	}
	body, err := memory.ReadRevisionBody(root, rev, 1024)
	if err != nil {
		t.Fatalf("ReadRevisionBody: %v", err)
	}
	if body != "revision body" {
		t.Fatalf("body = %q, want revision body", body)
	}
	pendingPath, err := memory.PendingBodyPath(root, rev)
	if err != nil {
		t.Fatalf("PendingBodyPath: %v", err)
	}
	if _, err := os.Stat(pendingPath); !os.IsNotExist(err) {
		t.Fatalf("pending file should be removed after finalize, stat err=%v", err)
	}
}

func TestReadRevisionBodyRequiresBodyPath(t *testing.T) {
	t.Parallel()
	rev := memory.MemoryRevision{
		UserID:     "user-1",
		AgentID:    "agent-1",
		ThreadID:   "thread-1",
		MemoryID:   "mem-1",
		Scope:      memory.ScopeThread,
		Revision:   1,
		MutationID: "run-1:call-1",
	}
	_, err := memory.ReadRevisionBody(t.TempDir(), rev, 1024)
	if !errors.Is(err, memory.ErrInvalidDocument) || !strings.Contains(err.Error(), "body_path") {
		t.Fatalf("expected body_path error, got %v", err)
	}
}
