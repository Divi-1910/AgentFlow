package memory

import (
	"fmt"
	"strings"

	"backend/runtimectx"
)

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
