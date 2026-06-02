package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"backend/llm"
	"backend/runtimectx"
	"backend/tools"
)

// DelegateInvoker runs a delegated agent and returns its final output string.
// The concrete implementation lives in the dispatcher package (it dispatches
// the target through the bus and applies depth/cycle/ownership guards) and is
// injected into the runtime via AgentRuntime.SetDelegateInvoker.
type DelegateInvoker interface {
	InvokeDelegate(ctx context.Context, parent runtimectx.DelegationInfo, targetAgentID, task string) (string, error)
}

// delegateTool exposes another agent as a callable tool. Synthesized per
// Agent.Delegates entry by BuildToolSet.
type delegateTool struct {
	cfg     DelegateConfig
	invoker DelegateInvoker // nil in validation-mode tool sets
}

func newDelegateTool(cfg DelegateConfig, inv DelegateInvoker) *delegateTool {
	return &delegateTool{cfg: cfg, invoker: inv}
}

func (t *delegateTool) Name() string { return t.cfg.ToolName }

func (t *delegateTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.cfg.ToolName,
		Description: t.cfg.Description,
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"task": {"type": "string", "description": "The task or question to delegate to this agent."}
			},
			"required": ["task"]
		}`),
		Instructions: t.cfg.Instructions,
	}
}

// Timeout returns 0 so the runtime inherits the parent context with no extra
// wall-clock cap — a delegate call is a full agent run, governed by the parent
// run plus the invoker's bus request bound, not the default 30s tool cap.
func (t *delegateTool) Timeout() time.Duration { return 0 }

func (t *delegateTool) Execute(ctx context.Context, call tools.ToolCall) (*tools.ToolResult, error) {
	if t.invoker == nil {
		return nil, fmt.Errorf("delegate %q: no invoker configured", t.cfg.ToolName)
	}
	info, ok := runtimectx.DelegationFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("delegate %q: missing delegation context", t.cfg.ToolName)
	}

	var args struct {
		Task string `json:"task"`
	}
	if err := json.Unmarshal(call.Args, &args); err != nil {
		return &tools.ToolResult{
			Content: fmt.Sprintf("invalid arguments for %s: %v", t.cfg.ToolName, err),
			IsError: true,
		}, nil
	}
	if strings.TrimSpace(args.Task) == "" {
		return &tools.ToolResult{
			Content: fmt.Sprintf("%s requires a non-empty \"task\"", t.cfg.ToolName),
			IsError: true,
		}, nil
	}

	out, err := t.invoker.InvokeDelegate(ctx, info, t.cfg.AgentID, args.Task)
	if err != nil {
		return &tools.ToolResult{
			Content: fmt.Sprintf("delegate %s failed: %v", t.cfg.ToolName, err),
			IsError: true,
		}, nil
	}
	return &tools.ToolResult{Content: out}, nil
}
