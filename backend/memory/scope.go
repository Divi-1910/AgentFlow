package memory

import (
	"fmt"
	"path/filepath"
	"strings"

	"backend/runtimectx"
)

func ResolveWritePath(root string, scope runtimectx.MemoryScope, requestedScope, memoryID string) (string, error) {
	if err := validateExecutionScope(scope); err != nil {
		return "", err
	}
	if !validScope(requestedScope) {
		return "", ErrInvalidScope
	}
	if err := validateSegment("memory_id", memoryID); err != nil {
		return "", err
	}

	switch requestedScope {
	case ScopeThread:
		return filepath.Join(root, scope.UserID, ScopeThread, scope.ThreadID, memoryID+".md"), nil
	case ScopeAgent:
		return filepath.Join(root, scope.UserID, ScopeAgent, scope.AgentID, memoryID+".md"), nil
	case ScopeUser:
		return filepath.Join(root, scope.UserID, ScopeUser, memoryID+".md"), nil
	default:
		return "", ErrInvalidScope
	}
}

func ResolveReadPath(root string, scope runtimectx.MemoryScope, requestedScope, memoryID string) (string, error) {
	return ResolveWritePath(root, scope, requestedScope, memoryID)
}

func ResolveSearchRoots(root string, scope runtimectx.MemoryScope, requestedScope string) ([]string, error) {
	if err := validateExecutionScope(scope); err != nil {
		return nil, err
	}
	if !validScope(requestedScope) {
		return nil, ErrInvalidScope
	}

	threadRoot := filepath.Join(root, scope.UserID, ScopeThread, scope.ThreadID)
	agentRoot := filepath.Join(root, scope.UserID, ScopeAgent, scope.AgentID)
	userRoot := filepath.Join(root, scope.UserID, ScopeUser)

	switch requestedScope {
	case ScopeThread:
		return []string{threadRoot}, nil
	case ScopeAgent:
		return []string{agentRoot, threadRoot}, nil
	case ScopeUser:
		return []string{userRoot, agentRoot, threadRoot}, nil
	default:
		return nil, ErrInvalidScope
	}
}

func ValidateDocumentPath(root, path string, doc MemoryDocument) error {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidDocument, err)
	}
	if strings.HasPrefix(rel, "..") {
		return fmt.Errorf("%w: path escapes root", ErrInvalidDocument)
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 3 {
		return fmt.Errorf("%w: invalid path shape", ErrInvalidDocument)
	}

	fileName := parts[len(parts)-1]
	fileID := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	if fileID != doc.ID {
		return fmt.Errorf("%w: file name and id mismatch", ErrInvalidDocument)
	}

	scopeDir := parts[1]
	switch scopeDir {
	case ScopeThread:
		if len(parts) != 4 || doc.Scope != ScopeThread || parts[2] != doc.ThreadID {
			return fmt.Errorf("%w: thread path does not match document metadata", ErrInvalidDocument)
		}
	case ScopeAgent:
		if len(parts) != 4 || doc.Scope != ScopeAgent || parts[2] != doc.AgentID {
			return fmt.Errorf("%w: agent path does not match document metadata", ErrInvalidDocument)
		}
	case ScopeUser:
		if len(parts) != 3 || doc.Scope != ScopeUser {
			return fmt.Errorf("%w: user path does not match document metadata", ErrInvalidDocument)
		}
	default:
		return fmt.Errorf("%w: unknown scope directory", ErrInvalidDocument)
	}

	return nil
}

func validateExecutionScope(scope runtimectx.MemoryScope) error {
	if err := validateSegment("user_id", scope.UserID); err != nil {
		return err
	}
	if err := validateSegment("agent_id", scope.AgentID); err != nil {
		return err
	}
	if err := validateSegment("thread_id", scope.ThreadID); err != nil {
		return err
	}
	return nil
}

func validateSegment(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalidDocument, name)
	}
	if value == "." || value == ".." || strings.Contains(value, "/") || strings.Contains(value, `\`) {
		return fmt.Errorf("%w: invalid %s", ErrInvalidDocument, name)
	}
	if len(value) > MaxSegmentLen {
		return fmt.Errorf("%w: %s exceeds maximum length of %d", ErrInvalidDocument, name, MaxSegmentLen)
	}
	for _, c := range value {
		if c < 0x20 || c == 0x7F {
			return fmt.Errorf("%w: %s contains control character", ErrInvalidDocument, name)
		}
	}
	return nil
}
