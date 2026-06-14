package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"backend/fsatomic"
)

// EnsureDir and WriteFileAtomic are re-exported from the shared fsatomic
// package (which the scratchpad subsystem also uses) so existing memory
// callers and tests keep working unchanged.
func EnsureDir(dir string) error                 { return fsatomic.EnsureDir(dir) }
func WriteFileAtomic(path, content string) error { return fsatomic.WriteFileAtomic(path, content) }

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

func RevisionBodyRelPath(rev MemoryRevision) (string, error) {
	if err := validateRevisionPathMetadata(rev); err != nil {
		return "", err
	}
	filename := fmt.Sprintf("%s_rev-%d.md", rev.MemoryID, rev.Revision)
	switch rev.Scope {
	case ScopeUser:
		return filepath.Join(rev.UserID, "memories", ScopeUser, rev.MemoryID, filename), nil
	case ScopeAgent:
		return filepath.Join(rev.UserID, "memories", ScopeAgent, rev.AgentID, rev.MemoryID, filename), nil
	case ScopeThread:
		return filepath.Join(rev.UserID, "memories", ScopeThread, rev.AgentID, rev.ThreadID, rev.MemoryID, filename), nil
	default:
		return "", ErrInvalidScope
	}
}

func RevisionBodyPath(root string, rev MemoryRevision) (string, error) {
	rel, err := RevisionBodyRelPath(rev)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, rel), nil
}

func PendingBodyPath(root string, rev MemoryRevision) (string, error) {
	if _, err := RevisionBodyRelPath(rev); err != nil {
		return "", err
	}
	if rev.MutationID == "" {
		return "", ErrMutationIDRequired
	}
	sum := sha256.Sum256([]byte(rev.MutationID))
	pendingName := hex.EncodeToString(sum[:]) + ".md"
	return filepath.Join(root, rev.UserID, "memories", ".pending", pendingName), nil
}

func WritePendingRevisionBody(root string, rev MemoryRevision, body string) error {
	if err := requireStoredBodyPath(rev); err != nil {
		return err
	}
	path, err := PendingBodyPath(root, rev)
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		return nil
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return fmt.Errorf("memory: stat pending revision body: %w", statErr)
	}
	dir := filepath.Dir(path)
	if err := EnsureDir(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".memory-pending-*")
	if err != nil {
		return fmt.Errorf("memory: create pending temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.WriteString(body); err != nil {
		tmp.Close()
		return fmt.Errorf("memory: write pending temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("memory: close pending temp file: %w", err)
	}
	if err := os.Link(tmpName, path); err != nil {
		if os.IsExist(err) {
			return nil
		}
		return fmt.Errorf("memory: install pending revision body: %w", err)
	}
	return nil
}

func FinalizeRevisionBody(root string, rev MemoryRevision) error {
	if err := requireStoredBodyPath(rev); err != nil {
		return err
	}
	finalPath, err := RevisionBodyPath(root, rev)
	if err != nil {
		return err
	}
	pendingPath, err := PendingBodyPath(root, rev)
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(finalPath); statErr == nil {
		_ = os.Remove(pendingPath)
		return nil
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return fmt.Errorf("memory: stat revision body: %w", statErr)
	}
	if err := EnsureDir(filepath.Dir(finalPath)); err != nil {
		return err
	}
	if err := os.Rename(pendingPath, finalPath); err != nil {
		if os.IsNotExist(err) {
			if _, statErr := os.Stat(finalPath); statErr == nil {
				return nil
			}
			return fmt.Errorf("%w: revision body file is missing: %s", ErrMemoryNotFound, rev.BodyPath)
		}
		return fmt.Errorf("memory: finalize revision body: %w", err)
	}
	return nil
}

func ReadRevisionBody(root string, rev MemoryRevision, maxBytes int) (string, error) {
	if err := requireStoredBodyPath(rev); err != nil {
		return "", err
	}
	path, err := RevisionBodyPath(root, rev)
	if err != nil {
		return "", err
	}
	data, err := ReadFileLimited(path, maxBytes)
	if errors.Is(err, ErrMemoryNotFound) {
		if finalizeErr := FinalizeRevisionBody(root, rev); finalizeErr != nil {
			return "", finalizeErr
		}
		data, err = ReadFileLimited(path, maxBytes)
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func removePendingRevisionBody(root string, rev MemoryRevision) {
	path, err := PendingBodyPath(root, rev)
	if err != nil {
		return
	}
	_ = os.Remove(path)
}

func requireStoredBodyPath(rev MemoryRevision) error {
	if rev.BodyPath == "" {
		return fmt.Errorf("%w: body_path is required", ErrInvalidDocument)
	}
	rel, err := RevisionBodyRelPath(rev)
	if err != nil {
		return err
	}
	if rev.BodyPath != rel {
		return fmt.Errorf("%w: body_path does not match revision metadata", ErrInvalidDocument)
	}
	return nil
}

func validateRevisionPathMetadata(rev MemoryRevision) error {
	if err := validateSegment("user_id", rev.UserID); err != nil {
		return err
	}
	if !validScope(rev.Scope) {
		return ErrInvalidScope
	}
	if err := validateSegment("memory_id", rev.MemoryID); err != nil {
		return err
	}
	if rev.Revision <= 0 {
		return fmt.Errorf("%w: revision must be positive", ErrInvalidDocument)
	}
	switch rev.Scope {
	case ScopeUser:
		return nil
	case ScopeAgent:
		return validateSegment("agent_id", rev.AgentID)
	case ScopeThread:
		if err := validateSegment("agent_id", rev.AgentID); err != nil {
			return err
		}
		return validateSegment("thread_id", rev.ThreadID)
	default:
		return ErrInvalidScope
	}
}
