// Package fsatomic provides small filesystem helpers shared by the memory and
// scratchpad subsystems: directory creation and atomic file writes via a
// temp-file rename. It carries no domain types so both packages can depend on
// it without coupling to each other.
package fsatomic

import (
	"fmt"
	"os"
	"path/filepath"
)

// EnsureDir creates dir (and parents) if missing.
func EnsureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("fsatomic: ensure dir: %w", err)
	}
	return nil
}

// WriteFileAtomic writes content to path atomically via a temp-file rename.
// Parent directories are created as needed.
func WriteFileAtomic(path, content string) error {
	dir := filepath.Dir(path)
	if err := EnsureDir(dir); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".fsatomic-*")
	if err != nil {
		return fmt.Errorf("fsatomic: create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return fmt.Errorf("fsatomic: write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("fsatomic: close temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("fsatomic: rename temp file: %w", err)
	}
	return nil
}
