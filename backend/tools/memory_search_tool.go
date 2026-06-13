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

type MemorySearchTool struct {
	service *memory.Service
}

func NewMemorySearchTool(service *memory.Service) *MemorySearchTool {
	return &MemorySearchTool{service: service}
}

func (t *MemorySearchTool) Name() string { return "memory_search" }

func (t *MemorySearchTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "memory_search",
		Description: "Searches previously written memories in the requested scope hierarchy and returns snippets only.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"pattern": {"type": "string", "description": "Case-insensitive literal text to search for"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"type": {"type": "string", "enum": ["fact", "preference", "procedure", "episode"]},
				"limit": {"type": "integer", "minimum": 1, "maximum": 20},
				"include_retired": {"type": "boolean", "description": "When true, include retired latest cache rows that have not expired."}
			},
			"required": ["pattern", "scope"]
		}`),
		Instructions: "Use memory_search to find active memories that are not in <memories><index>. Prefer short literal patterns. Results include snippets, revision, retired, and updated_at; use include_retired only when considering memory_restore.",
	}
}

func (t *MemorySearchTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemorySearchArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}

	scope, ok := runtimectx.MemoryScopeFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("%w: memory scope missing from execution context", ErrToolExecutionFailed)
	}

	result, err := t.service.Search(ctx, scope, input)
	if err != nil {
		if errors.Is(err, memory.ErrInvalidScope) || errors.Is(err, memory.ErrInvalidType) || errors.Is(err, memory.ErrInvalidDocument) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
		}
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}
