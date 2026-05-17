package memory

import (
	"fmt"
	"path/filepath"
	"strings"

	"backend/runtimectx"
)

// ResolveWritePath derives the filesystem path for a memory document.
// Path structure: {root}/{user_id}/{scope}[/{scope_id}]/{memory_id}.md
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

// ResolveReadPath is an alias for ResolveWritePath — the read and write paths
// for a memory document are identical.
func ResolveReadPath(root string, scope runtimectx.MemoryScope, requestedScope, memoryID string) (string, error) {
	return ResolveWritePath(root, scope, requestedScope, memoryID)
}

// ── Internal validation ───────────────────────────────────────────────────────

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
