package memory

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func EnsureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("memory: ensure dir: %w", err)
	}
	return nil
}

func WriteFileAtomic(path, content string) error {
	dir := filepath.Dir(path)
	if err := EnsureDir(dir); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".memory-*")
	if err != nil {
		return fmt.Errorf("memory: create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return fmt.Errorf("memory: write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("memory: close temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("memory: rename temp file: %w", err)
	}
	return nil
}

func ReadFileLimited(path string, maxBytes int) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrMemoryNotFound
		}
		return nil, fmt.Errorf("memory: stat file: %w", err)
	}
	if info.Size() > int64(maxBytes) {
		return nil, fmt.Errorf("%w: file exceeds max size", ErrInvalidDocument)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("memory: read file: %w", err)
	}
	return data, nil
}

func ListMarkdownFiles(root string) ([]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("memory: stat root: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("memory: root is not a directory: %s", root)
	}

	files := make([]string, 0)
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(d.Name()), ".md") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("memory: walk dir: %w", err)
	}
	return files, nil
}
