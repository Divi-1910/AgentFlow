package agent

import (
	"encoding/json"
	"strings"
)

func toolEventMeta(runCtx RunContext, callID, name string, args json.RawMessage, display, targetAgentID string, isDelegate bool) *ToolMeta {
	meta := &ToolMeta{
		ID:        callID,
		Name:      name,
		Kind:      ToolKindRegular,
		Operation: name,
		Display:   display,
		Args:      args,
	}

	switch {
	case isDelegate:
		meta.Kind = ToolKindDelegate
		meta.TargetAgentID = targetAgentID
	case name == AsyncToolDispatchAgent || name == AsyncToolAwaitJob:
		meta.Kind = ToolKindAsync
	case strings.HasPrefix(name, "memory_"):
		meta.Kind = ToolKindMemory
		meta.Operation = strings.TrimPrefix(name, "memory_")
	case strings.HasPrefix(name, "scratchpad_"):
		meta.Kind = ToolKindScratchpad
		meta.Operation = strings.TrimPrefix(name, "scratchpad_")
	case strings.HasPrefix(name, "mcp__"):
		meta.Kind = ToolKindMCP
		parts := strings.SplitN(strings.TrimPrefix(name, "mcp__"), "__", 2)
		if len(parts) > 0 {
			meta.MCPAlias = parts[0]
			meta.MCPServerID = runCtx.MCPServerIDs[parts[0]]
		}
		if len(parts) == 2 {
			meta.Operation = parts[1]
		}
	}
	meta.Presentation = buildToolPresentation(meta, args, "")

	return meta
}

func toolEventMetaWithResult(runCtx RunContext, callID, name string, args json.RawMessage, display, targetAgentID string, isDelegate bool, result string) *ToolMeta {
	meta := toolEventMeta(runCtx, callID, name, args, display, targetAgentID, isDelegate)
	meta.Presentation = buildToolPresentation(meta, args, result)
	return meta
}
