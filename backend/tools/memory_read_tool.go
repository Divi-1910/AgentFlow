package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"backend/llm"
	"backend/memory"
	"backend/runtimectx"
)

type MemoryReadTool struct {
	service *memory.Service
}

func NewMemoryReadTool(service *memory.Service) *MemoryReadTool {
	return &MemoryReadTool{service: service}
}

func (t *MemoryReadTool) Name() string { return "memory_read" }

func (t *MemoryReadTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "memory_read",
		Description: "Reads a full memory document by memory_id and scope.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memory_id": {"type": "string"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]}
			},
			"required": ["memory_id", "scope"]
		}`),
		Instructions: "Use memory_read to fetch the full body of a memory you have already seen in <memories><index>. Always call memory_read before any memory_write that overwrites an existing memory ID — writes without a recent read are rejected. Do not call memory_read for user-scoped memories that already appear in <user_preferences> in full.",
	}
}

func (t *MemoryReadTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryReadArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}

	scope, ok := runtimectx.MemoryScopeFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("%w: memory scope missing from execution context", ErrToolExecutionFailed)
	}

	result, err := t.service.Read(ctx, scope, input)
	if err != nil {
		if errors.Is(err, memory.ErrInvalidScope) || errors.Is(err, memory.ErrInvalidDocument) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
		}
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}
