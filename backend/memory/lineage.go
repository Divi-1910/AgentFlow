package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"backend/runtimectx"
)

func LineageKey(scope runtimectx.MemoryScope, requestedScope, memoryID string) (string, error) {
	if err := validateExecutionScope(scope); err != nil {
		return "", err
	}
	if !validScope(requestedScope) {
		return "", ErrInvalidScope
	}
	if err := validateSegment("memory_id", memoryID); err != nil {
		return "", err
	}

	var parts []string
	switch requestedScope {
	case ScopeUser:
		parts = []string{"memory-lineage-v1", ScopeUser, scope.UserID, requestedScope, memoryID}
	case ScopeAgent:
		parts = []string{"memory-lineage-v1", ScopeAgent, scope.UserID, scope.AgentID, requestedScope, memoryID}
	case ScopeThread:
		parts = []string{"memory-lineage-v1", ScopeThread, scope.UserID, scope.AgentID, scope.ThreadID, requestedScope, memoryID}
	default:
		return "", ErrInvalidScope
	}
	data, err := json.Marshal(parts)
	if err != nil {
		return "", fmt.Errorf("memory: encode lineage key: %w", err)
	}
	return string(data), nil
}

func MutationID(runID, toolCallID string) (string, error) {
	if runID == "" || toolCallID == "" {
		return "", ErrMutationIDRequired
	}
	return runID + ":" + toolCallID, nil
}

func DerivedMemoryID(runID, toolCallID string) (string, error) {
	mutationID, err := MutationID(runID, toolCallID)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(mutationID))
	return hex.EncodeToString(sum[:8]), nil
}
