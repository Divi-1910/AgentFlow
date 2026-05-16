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

// ── ListMarkdownFiles ─────────────────────────────────────────────────────────

func TestListMarkdownFilesFindsOnlyMdFiles(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, name := range []string{"a.md", "b.MD", "c.txt", "d.go"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile %s: %v", name, err)
		}
	}
	files, err := memory.ListMarkdownFiles(root)
	if err != nil {
		t.Fatalf("ListMarkdownFiles: %v", err)
	}
	// a.md and b.MD match (case-insensitive); c.txt and d.go do not.
	if len(files) != 2 {
		t.Errorf("expected 2 .md files, got %d: %v", len(files), files)
	}
}

func TestListMarkdownFilesWalksSubdirectories(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for _, path := range []string{filepath.Join(root, "top.md"), filepath.Join(sub, "nested.md")} {
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile %s: %v", path, err)
		}
	}
	files, err := memory.ListMarkdownFiles(root)
	if err != nil {
		t.Fatalf("ListMarkdownFiles: %v", err)
	}
	if len(files) != 2 {
		t.Errorf("expected 2 files (top + nested), got %d", len(files))
	}
}

func TestListMarkdownFilesReturnsNilForNonexistentDir(t *testing.T) {
	t.Parallel()
	files, err := memory.ListMarkdownFiles(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("expected nil error for nonexistent dir, got: %v", err)
	}
	if files != nil {
		t.Errorf("expected nil slice, got: %v", files)
	}
}
