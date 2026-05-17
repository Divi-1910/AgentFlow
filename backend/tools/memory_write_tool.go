package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"backend/llm"
	"backend/memory"
	"backend/runtimectx"
)

type MemoryWriteTool struct {
	service *memory.Service
}

func NewMemoryWriteTool(service *memory.Service) *MemoryWriteTool {
	return &MemoryWriteTool{service: service}
}

func (t *MemoryWriteTool) Name() string { return "memory_write" }

func (t *MemoryWriteTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "memory_write",
		Description: "Writes a durable memory for the current user, agent, or thread. Use this only when something is worth remembering for later.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"content": {"type": "string", "description": "The memory body to store"},
				"type": {"type": "string", "enum": ["fact", "preference", "procedure", "episode"]},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"importance": {"type": "number", "minimum": 0, "maximum": 1},
				"ttl_days": {"type": "integer", "minimum": 1}
			},
			"required": ["content", "type", "scope", "importance"]
		}`),
		Instructions: "Use memory_write when the user states a durable preference, fact, or decision that should outlast the current turn. Pick the narrowest scope: thread for things tied to this conversation, agent for things across this user's chats with you, user for cross-agent preferences. Start the content with a one-line summary — it becomes the preview in <memories><index>. Set ttl_days for facts that go stale (deadlines, on-call rotations); omit it for stable preferences. Before overwriting an existing memory ID, call memory_read first.",
	}
}

func (t *MemoryWriteTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryWriteArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}

	scope, ok := runtimectx.MemoryScopeFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("%w: memory scope missing from execution context", ErrToolExecutionFailed)
	}

	if call.ID == "" {
		return nil, fmt.Errorf("%w: call.ID is required for memory_write", ErrToolExecutionFailed)
	}
	memoryID := deriveMemoryID(call.ID)

	result, err := t.service.Write(ctx, scope, memoryID, input)
	if err != nil {
		if errors.Is(err, memory.ErrReadBeforeWrite) {
			return toolJSONError(errors.New("Read this file using memory_read : Before making a write"))
		}
		if isMemoryArgError(err) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
		}
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}

func deriveMemoryID(callID string) string {
	h := sha256.Sum256([]byte(callID))
	return hex.EncodeToString(h[:8])
}

func isMemoryArgError(err error) bool {
	return errors.Is(err, memory.ErrInvalidScope) ||
		errors.Is(err, memory.ErrInvalidType) ||
		errors.Is(err, memory.ErrInvalidDocument)
}
