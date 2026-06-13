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

type MemoryPatchTool struct{ service *memory.Service }
type MemoryUpdateTool struct{ service *memory.Service }
type MemoryRetireTool struct{ service *memory.Service }
type MemoryRestoreTool struct{ service *memory.Service }
type MemoryHistoryTool struct{ service *memory.Service }

func NewMemoryPatchTool(service *memory.Service) *MemoryPatchTool {
	return &MemoryPatchTool{service: service}
}
func NewMemoryUpdateTool(service *memory.Service) *MemoryUpdateTool {
	return &MemoryUpdateTool{service: service}
}
func NewMemoryRetireTool(service *memory.Service) *MemoryRetireTool {
	return &MemoryRetireTool{service: service}
}
func NewMemoryRestoreTool(service *memory.Service) *MemoryRestoreTool {
	return &MemoryRestoreTool{service: service}
}
func NewMemoryHistoryTool(service *memory.Service) *MemoryHistoryTool {
	return &MemoryHistoryTool{service: service}
}

func (t *MemoryPatchTool) Name() string   { return "memory_patch" }
func (t *MemoryUpdateTool) Name() string  { return "memory_update" }
func (t *MemoryRetireTool) Name() string  { return "memory_retire" }
func (t *MemoryRestoreTool) Name() string { return "memory_restore" }
func (t *MemoryHistoryTool) Name() string { return "memory_history" }

func (t *MemoryPatchTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Appends a new memory revision by exact block replacement.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memory_id": {"type": "string"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"expected_revision": {"type": "integer", "minimum": 1},
				"reason": {"type": "string"},
				"edits": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"old_text": {"type": "string"},
							"new_text": {"type": "string"}
						},
						"required": ["old_text", "new_text"]
					}
				}
			},
			"required": ["memory_id", "scope", "expected_revision", "reason", "edits"]
		}`),
		Instructions: "Use memory_patch for small exact edits to an active memory. Each old_text must match exactly once, edits must not overlap, and expected_revision must be the latest revision you observed.",
	}
}

func (t *MemoryUpdateTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Appends a new memory revision by replacing the full body.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memory_id": {"type": "string"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"expected_revision": {"type": "integer", "minimum": 1},
				"reason": {"type": "string"},
				"content": {"type": "string"}
			},
			"required": ["memory_id", "scope", "expected_revision", "reason", "content"]
		}`),
		Instructions: "Use memory_update when replacing the full body of an active memory is clearer than patching. Preserve durable facts that should remain, and include expected_revision.",
	}
}

func (t *MemoryRetireTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Appends a retire revision so a memory no longer appears in default reads or search.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memory_id": {"type": "string"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"expected_revision": {"type": "integer", "minimum": 1},
				"reason": {"type": "string"}
			},
			"required": ["memory_id", "scope", "expected_revision", "reason"]
		}`),
		Instructions: "Use memory_retire when a memory should stop competing in context or search. Retired memory can still be inspected through memory_history and restored later.",
	}
}

func (t *MemoryRestoreTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Appends a restore revision from an earlier revision.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memory_id": {"type": "string"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]},
				"expected_revision": {"type": "integer", "minimum": 1},
				"from_revision": {"type": "integer", "minimum": 1},
				"reason": {"type": "string"}
			},
			"required": ["memory_id", "scope", "expected_revision", "reason"]
		}`),
		Instructions: "Use memory_restore after memory_history when an earlier body should become active again. If latest is retired, from_revision may be omitted to restore the latest non-retired revision; if latest is active, from_revision is required.",
	}
}

func (t *MemoryHistoryTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Lists the revision history for one memory lineage.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memory_id": {"type": "string"},
				"scope": {"type": "string", "enum": ["thread", "agent", "user"]}
			},
			"required": ["memory_id", "scope"]
		}`),
		Instructions: "Use memory_history to inspect prior revisions before reading a historical revision or restoring one.",
	}
}

func (t *MemoryPatchTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryPatchArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	input.RunID = call.RunID
	input.ToolCallID = call.ID
	scope, err := memoryToolScope(ctx)
	if err != nil {
		return nil, err
	}
	result, err := t.service.Patch(ctx, scope, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}

func (t *MemoryUpdateTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryUpdateArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	input.RunID = call.RunID
	input.ToolCallID = call.ID
	scope, err := memoryToolScope(ctx)
	if err != nil {
		return nil, err
	}
	result, err := t.service.Update(ctx, scope, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}

func (t *MemoryRetireTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryRetireArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	input.RunID = call.RunID
	input.ToolCallID = call.ID
	scope, err := memoryToolScope(ctx)
	if err != nil {
		return nil, err
	}
	result, err := t.service.Retire(ctx, scope, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}

func (t *MemoryRestoreTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryRestoreArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	input.RunID = call.RunID
	input.ToolCallID = call.ID
	scope, err := memoryToolScope(ctx)
	if err != nil {
		return nil, err
	}
	result, err := t.service.Restore(ctx, scope, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}

func (t *MemoryHistoryTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input memory.MemoryHistoryArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	scope, err := memoryToolScope(ctx)
	if err != nil {
		return nil, err
	}
	result, err := t.service.History(ctx, scope, input)
	if err != nil {
		if errors.Is(err, memory.ErrInvalidScope) || errors.Is(err, memory.ErrInvalidDocument) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
		}
		return toolJSONError(err)
	}
	return toolJSONResult(result)
}

func memoryToolScope(ctx context.Context) (runtimectx.MemoryScope, error) {
	scope, ok := runtimectx.MemoryScopeFromContext(ctx)
	if !ok {
		return runtimectx.MemoryScope{}, fmt.Errorf("%w: memory scope missing from execution context", ErrToolExecutionFailed)
	}
	return scope, nil
}
