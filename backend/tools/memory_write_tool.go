package tools

import (
	"context"
	"encoding/json"
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
				"memory_id": {"type": "string", "description": "Optional stable slug for this new memory. If omitted, a run-scoped ID is generated."},
				"type": {"type": "string", "enum": ["fact", "preference", "procedure", "episode"]},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"importance": {"type": "number", "minimum": 0, "maximum": 1},
				"ttl_days": {"type": "integer", "minimum": 1}
			},
			"required": ["content", "type", "scope", "importance"]
		}`),
		Instructions: "Use memory_write to create a new durable memory. Pick the narrowest scope: thread for this conversation, agent for this user's chats with you, user for cross-agent preferences. Use a stable memory_id only when you are intentionally creating a named memory; existing memory IDs cannot be recreated. Use memory_patch or memory_update to change an existing memory.",
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

	input.RunID = call.RunID
	input.ToolCallID = call.ID

	result, err := t.service.Write(ctx, scope, input.MemoryID, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}
