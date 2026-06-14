package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"backend/llm"
	"backend/runtimectx"
	"backend/scratchpad"
)

type ScratchpadCreateTool struct{ service *scratchpad.Service }
type ScratchpadAppendTool struct{ service *scratchpad.Service }
type ScratchpadReplaceTool struct{ service *scratchpad.Service }
type ScratchpadListTool struct{ service *scratchpad.Service }
type ScratchpadGetSectionsTool struct{ service *scratchpad.Service }
type ScratchpadReadSectionTool struct{ service *scratchpad.Service }
type ScratchpadSearchTool struct{ service *scratchpad.Service }

func NewScratchpadCreateTool(s *scratchpad.Service) *ScratchpadCreateTool {
	return &ScratchpadCreateTool{s}
}
func NewScratchpadAppendTool(s *scratchpad.Service) *ScratchpadAppendTool {
	return &ScratchpadAppendTool{s}
}
func NewScratchpadReplaceTool(s *scratchpad.Service) *ScratchpadReplaceTool {
	return &ScratchpadReplaceTool{s}
}
func NewScratchpadListTool(s *scratchpad.Service) *ScratchpadListTool { return &ScratchpadListTool{s} }
func NewScratchpadGetSectionsTool(s *scratchpad.Service) *ScratchpadGetSectionsTool {
	return &ScratchpadGetSectionsTool{s}
}
func NewScratchpadReadSectionTool(s *scratchpad.Service) *ScratchpadReadSectionTool {
	return &ScratchpadReadSectionTool{s}
}
func NewScratchpadSearchTool(s *scratchpad.Service) *ScratchpadSearchTool {
	return &ScratchpadSearchTool{s}
}

func (t *ScratchpadCreateTool) Name() string      { return "scratchpad_create" }
func (t *ScratchpadAppendTool) Name() string      { return "scratchpad_append_section" }
func (t *ScratchpadReplaceTool) Name() string     { return "scratchpad_replace_section" }
func (t *ScratchpadListTool) Name() string        { return "scratchpad_list" }
func (t *ScratchpadGetSectionsTool) Name() string { return "scratchpad_get_sections" }
func (t *ScratchpadReadSectionTool) Name() string { return "scratchpad_read_section" }
func (t *ScratchpadSearchTool) Name() string      { return "scratchpad_search" }

const scratchpadPurpose = "The scratchpad is a SHARED workspace for every agent working on this task. Use it for collaboration artifacts other agents need — plans, research findings, attributed contributions, corrections — NOT for private reasoning or progress narration."

func (t *ScratchpadCreateTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Creates a new shared scratchpad file with an initial section.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"title": {"type": "string", "description": "Short title for the file."},
				"heading": {"type": "string", "description": "Heading for the initial section."},
				"content": {"type": "string", "description": "Content of the initial section (markdown)."}
			},
			"required": ["title", "heading", "content"]
		}`),
		Instructions: scratchpadPurpose + " Create a file when starting a new shared artifact. Returns file_id and section_id; share or reuse the file_id so other agents append to the same file.",
	}
}

func (t *ScratchpadAppendTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Appends a new section (owned by you) to an existing scratchpad file.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file_id": {"type": "string"},
				"heading": {"type": "string"},
				"content": {"type": "string"}
			},
			"required": ["file_id", "heading", "content"]
		}`),
		Instructions: "Append your own contribution to an existing file. To disagree with or correct ANOTHER agent's section, append a correction section here — never edit theirs. Fails if the file does not exist; create it explicitly first.",
	}
}

func (t *ScratchpadReplaceTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Replaces the full content of a section you own.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file_id": {"type": "string"},
				"section_id": {"type": "string"},
				"heading": {"type": "string"},
				"content": {"type": "string"},
				"expected_hash": {"type": "string", "description": "content_hash you last observed (from get_sections); guards against a stale overwrite."}
			},
				"required": ["file_id", "section_id", "heading", "content", "expected_hash"]
			}`),
		Instructions: "Only the owner of a section may replace it. Pass expected_hash from get_sections; if it is rejected as stale, re-read the section and retry. To change another agent's section, append a correction instead.",
	}
}

func (t *ScratchpadListTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:         t.Name(),
		Description:  "Lists the shared scratchpad files for this task.",
		Parameters:   json.RawMessage(`{"type": "object", "properties": {}}`),
		Instructions: scratchpadPurpose + " Start here to discover what other agents have written.",
	}
}

func (t *ScratchpadGetSectionsTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Lists a file's sections with heading, author, size, content_hash, and a short preview.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {"file_id": {"type": "string"}},
			"required": ["file_id"]
		}`),
		Instructions: "Use before read_section (to pick a section) or replace_section (to get content_hash). Previews are truncated; read_section for full content.",
	}
}

func (t *ScratchpadReadSectionTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Reads the full content of one section.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file_id": {"type": "string"},
				"section_id": {"type": "string"}
			},
			"required": ["file_id", "section_id"]
		}`),
		Instructions: "Read a specific section's full content after discovering it via get_sections or search.",
	}
}

func (t *ScratchpadSearchTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.Name(),
		Description: "Case-insensitive fixed-string search across this task's scratchpad sections.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"pattern": {"type": "string"},
				"limit": {"type": "integer", "minimum": 1, "maximum": 50}
			},
			"required": ["pattern"]
		}`),
		Instructions: "Find sections by content across all files in this task's scratchpad. Returns matching sections with file_id, section_id, author, and a snippet.",
	}
}

func (t *ScratchpadCreateTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input scratchpad.CreateArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	ws, agentID, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	input.RunID, input.ToolCallID = call.RunID, call.ID
	res, err := t.service.Create(ctx, ws, agentID, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

func (t *ScratchpadAppendTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input scratchpad.AppendArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	ws, agentID, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	input.RunID, input.ToolCallID = call.RunID, call.ID
	res, err := t.service.Append(ctx, ws, agentID, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

func (t *ScratchpadReplaceTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input scratchpad.ReplaceArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	ws, agentID, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	input.RunID, input.ToolCallID = call.RunID, call.ID
	res, err := t.service.Replace(ctx, ws, agentID, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

func (t *ScratchpadListTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	ws, _, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	res, err := t.service.List(ctx, ws)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

func (t *ScratchpadGetSectionsTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input scratchpad.GetSectionsArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	ws, _, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	res, err := t.service.GetSections(ctx, ws, input.FileID)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

func (t *ScratchpadReadSectionTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input scratchpad.ReadSectionArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	ws, _, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	res, err := t.service.ReadSection(ctx, ws, input.FileID, input.SectionID)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

func (t *ScratchpadSearchTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	var input scratchpad.SearchArgs
	if err := json.Unmarshal(call.Args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	ws, _, err := scratchpadContext(ctx)
	if err != nil {
		return nil, err
	}
	res, err := t.service.Search(ctx, ws, input)
	if err != nil {
		return toolJSONError(err)
	}
	return toolJSONResult(res)
}

// scratchpadContext resolves the task workspace + owning agent from runtime
// context. user_id/agent_id come from the memory scope; originator_run_id from
// the delegation info (== run_id for a top-level run). Both are always set by
// the runtime's tool dispatch (agent/tool_batch.go).
func scratchpadContext(ctx context.Context) (scratchpad.Workspace, string, error) {
	scope, ok := runtimectx.MemoryScopeFromContext(ctx)
	if !ok || scope.UserID == "" || scope.AgentID == "" {
		return scratchpad.Workspace{}, "", fmt.Errorf("%w: memory scope missing from execution context", ErrToolExecutionFailed)
	}
	del, ok := runtimectx.DelegationFromContext(ctx)
	if !ok || del.OriginatorRunID == "" {
		return scratchpad.Workspace{}, "", fmt.Errorf("%w: delegation context missing originator run", ErrToolExecutionFailed)
	}
	return scratchpad.Workspace{UserID: scope.UserID, OriginatorRunID: del.OriginatorRunID}, scope.AgentID, nil
}
