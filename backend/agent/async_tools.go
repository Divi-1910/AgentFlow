package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"backend/llm"
	"backend/tools"
)

const (
	awaitMetadataPending      = "await_pending"
	awaitMetadataTerminal     = "await_terminal"
	awaitMetadataJobID        = "job_id"
	awaitMetadataCreatedAt    = "created_at"
	awaitMetadataDelegateTool = "delegate_tool"
	awaitMetadataStatus       = "job_status"
	awaitMetadataOutput       = "job_output"
	awaitMetadataError        = "job_error"
)

type asyncRunInfoKey struct{}

type asyncRunInfo struct {
	RunID           string
	OriginatorRunID string
	ThreadID        string
	AgentID         string
	UserID          string
	InvocationKind  string
	Chain           []string
	Depth           int
}

func withAsyncRunInfo(ctx context.Context, info asyncRunInfo) context.Context {
	return context.WithValue(ctx, asyncRunInfoKey{}, info)
}

func asyncRunInfoFromContext(ctx context.Context) (asyncRunInfo, bool) {
	info, ok := ctx.Value(asyncRunInfoKey{}).(asyncRunInfo)
	return info, ok
}

type dispatchAgentTool struct {
	toolSet *ToolSet
	store   AsyncJobStore
}

func newDispatchAgentTool(ts *ToolSet, store AsyncJobStore) *dispatchAgentTool {
	return &dispatchAgentTool{toolSet: ts, store: store}
}

func (t *dispatchAgentTool) Name() string { return AsyncToolDispatchAgent }

func (t *dispatchAgentTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        AsyncToolDispatchAgent,
		Description: "Dispatch a configured delegate agent as a durable asynchronous job and return a job_id immediately.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"delegate_tool": {"type": "string", "description": "The configured delegate tool name to dispatch, such as ask_researcher."},
				"task": {"type": "string", "description": "The task or question for the delegated agent."},
				"mode": {"type": "string", "enum": ["required", "background"], "description": "required waits before final answer; background triggers a later callback."},
				"callback_instruction": {"type": "string", "description": "For background jobs only, how to notify the user when complete."}
			},
			"required": ["delegate_tool", "task", "mode"]
		}`),
		Instructions: "Use mode=required when your final answer depends on the delegated result. Use mode=background only when the user can receive a follow-up later.",
	}
}

func (t *dispatchAgentTool) Timeout() time.Duration { return 0 }

func (t *dispatchAgentTool) Execute(ctx context.Context, call tools.ToolCall) (*tools.ToolResult, error) {
	if t.store == nil {
		return nil, fmt.Errorf("dispatch_agent: async job store is not configured")
	}
	info, ok := asyncRunInfoFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("dispatch_agent: missing run context")
	}
	if info.InvocationKind == InvocationSyncDelegate {
		return &tools.ToolResult{Content: `{"error":"dispatch_agent is not available inside synchronous delegate runs"}`, IsError: true}, nil
	}

	var args struct {
		DelegateTool        string `json:"delegate_tool"`
		Task                string `json:"task"`
		Mode                string `json:"mode"`
		CallbackInstruction string `json:"callback_instruction"`
	}
	if err := json.Unmarshal(call.Args, &args); err != nil {
		return &tools.ToolResult{Content: fmt.Sprintf(`{"error":"invalid dispatch_agent arguments: %s"}`, jsonEscape(err.Error())), IsError: true}, nil
	}
	args.DelegateTool = strings.TrimSpace(args.DelegateTool)
	args.Task = strings.TrimSpace(args.Task)
	args.Mode = strings.TrimSpace(args.Mode)
	args.CallbackInstruction = strings.TrimSpace(args.CallbackInstruction)
	if args.DelegateTool == "" || args.Task == "" {
		return &tools.ToolResult{Content: `{"error":"dispatch_agent requires delegate_tool and task"}`, IsError: true}, nil
	}
	if args.Mode != JobModeRequired && args.Mode != JobModeBackground {
		return &tools.ToolResult{Content: `{"error":"dispatch_agent mode must be required or background"}`, IsError: true}, nil
	}
	if args.Mode == JobModeRequired && args.CallbackInstruction != "" {
		return &tools.ToolResult{Content: `{"error":"callback_instruction is only allowed for background jobs"}`, IsError: true}, nil
	}
	if args.Mode == JobModeBackground && args.CallbackInstruction == "" {
		args.CallbackInstruction = DefaultCallbackInstruction
	}
	target, ok := t.toolSet.DelegateTarget(args.DelegateTool)
	if !ok {
		return &tools.ToolResult{Content: fmt.Sprintf(`{"error":"unknown delegate_tool %q"}`, args.DelegateTool), IsError: true}, nil
	}
	for _, agentID := range info.Chain {
		if agentID == target {
			return &tools.ToolResult{Content: fmt.Sprintf(`{"error":"delegation cycle detected for target %q"}`, target), IsError: true}, nil
		}
	}
	if info.Depth >= DefaultMaxDelegationDepth {
		return &tools.ToolResult{Content: `{"error":"delegation depth exceeded"}`, IsError: true}, nil
	}

	res, err := t.store.DispatchAgent(ctx, DispatchAgentRequest{
		ParentRunID:         info.RunID,
		OriginatorRunID:     info.OriginatorRunID,
		ParentThreadID:      info.ThreadID,
		ParentAgentID:       info.AgentID,
		UserID:              info.UserID,
		ToolCallID:          call.ID,
		DelegateTool:        args.DelegateTool,
		TargetAgentID:       target,
		Task:                args.Task,
		Mode:                args.Mode,
		CallbackInstruction: args.CallbackInstruction,
		DelegationChain:     info.Chain,
		DelegationDepth:     info.Depth,
	})
	if err != nil {
		var budgetErr RunBudgetError
		if errors.As(err, &budgetErr) {
			body, _ := json.Marshal(map[string]any{
				"error":     "run budget exhausted",
				"max_runs":  budgetErr.MaxRuns,
				"runs_used": budgetErr.RunsUsed,
			})
			return &tools.ToolResult{Content: string(body), IsError: true}, nil
		}
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{
		"job_id":        res.JobID,
		"status":        res.Status,
		"mode":          res.Mode,
		"delegate_tool": res.DelegateTool,
	})
	return &tools.ToolResult{
		Content: string(body),
		Metadata: map[string]any{
			"job_dispatched":  true,
			"job_id":          res.JobID,
			"job_status":      res.Status,
			"job_mode":        res.Mode,
			"delegate_tool":   res.DelegateTool,
			"target_agent_id": target,
		},
	}, nil
}

type awaitJobTool struct {
	store AsyncJobStore
}

func newAwaitJobTool(store AsyncJobStore) *awaitJobTool {
	return &awaitJobTool{store: store}
}

func (t *awaitJobTool) Name() string { return AsyncToolAwaitJob }

func (t *awaitJobTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        AsyncToolAwaitJob,
		Description: "Await a previously dispatched required job and receive its result when available.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"job_id": {"type": "string", "description": "The job_id returned by dispatch_agent."}
			},
			"required": ["job_id"]
		}`),
		Instructions: "Call await_job for required delegated work before using the delegated result in a final answer.",
	}
}

func (t *awaitJobTool) Timeout() time.Duration { return 0 }

func (t *awaitJobTool) Execute(ctx context.Context, call tools.ToolCall) (*tools.ToolResult, error) {
	if t.store == nil {
		return nil, fmt.Errorf("await_job: async job store is not configured")
	}
	info, ok := asyncRunInfoFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("await_job: missing run context")
	}
	if info.InvocationKind == InvocationSyncDelegate {
		return &tools.ToolResult{Content: `{"error":"await_job is not available inside synchronous delegate runs"}`, IsError: true}, nil
	}

	var args struct {
		JobID string `json:"job_id"`
	}
	if err := json.Unmarshal(call.Args, &args); err != nil {
		return &tools.ToolResult{Content: fmt.Sprintf(`{"error":"invalid await_job arguments: %s"}`, jsonEscape(err.Error())), IsError: true}, nil
	}
	args.JobID = strings.TrimSpace(args.JobID)
	if args.JobID == "" {
		return &tools.ToolResult{Content: `{"error":"await_job requires job_id"}`, IsError: true}, nil
	}

	res, err := t.store.AwaitJob(ctx, AwaitJobRequest{
		RunID:           info.RunID,
		OriginatorRunID: info.OriginatorRunID,
		UserID:          info.UserID,
		JobID:           args.JobID,
		ToolCallID:      call.ID,
	})
	if err != nil {
		return nil, err
	}
	if res.Pending {
		return &tools.ToolResult{
			Metadata: map[string]any{
				awaitMetadataPending:      true,
				awaitMetadataJobID:        res.JobID,
				awaitMetadataCreatedAt:    res.CreatedAt,
				awaitMetadataDelegateTool: res.DelegateTool,
			},
		}, nil
	}
	return awaitResultToToolResult(res)
}

func awaitResultToToolResult(res AwaitJobResult) (*tools.ToolResult, error) {
	meta := map[string]any{
		awaitMetadataTerminal:     true,
		awaitMetadataJobID:        res.JobID,
		awaitMetadataCreatedAt:    res.CreatedAt,
		awaitMetadataDelegateTool: res.DelegateTool,
		awaitMetadataStatus:       res.Status,
		awaitMetadataOutput:       res.Output,
		awaitMetadataError:        res.Error,
	}
	if res.Status == "succeeded" {
		body, _ := json.Marshal(map[string]string{
			"job_id": res.JobID,
			"status": "succeeded",
			"output": res.Output,
		})
		return &tools.ToolResult{Content: string(body), Metadata: meta}, nil
	}
	body, _ := json.Marshal(map[string]string{
		"job_id": res.JobID,
		"status": "failed",
		"error":  res.Error,
	})
	return &tools.ToolResult{Content: string(body), IsError: true, Metadata: meta}, nil
}

func jsonEscape(s string) string {
	b, _ := json.Marshal(s)
	if len(b) < 2 {
		return s
	}
	return string(b[1 : len(b)-1])
}

func asyncRunInfoForToolContext(runCtx RunContext) asyncRunInfo {
	kind := runCtx.InvocationKind
	if kind == "" {
		kind = InvocationTopLevel
	}
	return asyncRunInfo{
		RunID:           runCtx.RunID,
		OriginatorRunID: runCtx.OriginatorRunID,
		ThreadID:        runCtx.ThreadID,
		AgentID:         runCtx.Memory.AgentID,
		UserID:          runCtx.Memory.UserID,
		InvocationKind:  kind,
		Chain:           append([]string(nil), runCtx.DelegationChain...),
		Depth:           runCtx.DelegationDepth,
	}
}
