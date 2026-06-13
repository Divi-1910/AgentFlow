package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"backend/runtimectx"
)

func EnsureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("memory: ensure dir: %w", err)
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

// ReadFileLimited reads path up to maxBytes. Returns ErrMemoryNotFound when
// the file does not exist, and ErrInvalidDocument when it exceeds maxBytes.
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

func BodySHA(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

func BlobPath(root, userID, bodySHA string) (string, error) {
	if err := validateSegment("user_id", userID); err != nil {
		return "", err
	}
	if len(bodySHA) != 64 {
		return "", fmt.Errorf("%w: invalid body_sha", ErrInvalidDocument)
	}
	for _, c := range bodySHA {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return "", fmt.Errorf("%w: invalid body_sha", ErrInvalidDocument)
		}
	}
	return filepath.Join(root, userID, "blobs", bodySHA), nil
}

func WriteBlob(root, userID, body string) (string, error) {
	sha := BodySHA(body)
	path, err := BlobPath(root, userID, sha)
	if err != nil {
		return "", err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		return sha, nil
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return "", fmt.Errorf("memory: stat blob: %w", statErr)
	}
	if err := WriteFileAtomic(path, body); err != nil {
		return "", err
	}
	return sha, nil
}

func ReadBlob(root, userID, bodySHA string, maxBytes int) (string, error) {
	path, err := BlobPath(root, userID, bodySHA)
	if err != nil {
		return "", err
	}
	data, err := ReadFileLimited(path, maxBytes)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func LegacyDocumentPath(root string, doc MemoryDocument) (string, error) {
	return ResolveReadPath(root, runtimectx.MemoryScope{
		UserID:   doc.UserID,
		AgentID:  doc.AgentID,
		ThreadID: doc.ThreadID,
	}, doc.Scope, doc.ID)
}
