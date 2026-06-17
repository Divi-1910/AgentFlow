package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"backend/llm"
	"backend/runtimectx"
	"backend/tools"
)

type plannedCall struct {
	index          int
	call           llm.ToolCall
	tool           tools.Tool
	rawArgs        json.RawMessage
	delegateTarget string
	isDelegate     bool
}

type missingCall struct {
	index   int
	call    llm.ToolCall
	rawArgs json.RawMessage
}

type toolCallGroup struct {
	calls []plannedCall
}

type toolOutcome struct {
	index              int
	toolName           string
	message            llm.ChatMessage
	execFailed         bool
	thresholdErrorText string
	lastAction         string
	ran                bool
	awaitPending       bool
	pendingAwait       PendingAwait
	awaitDelivered     bool
	deliveredAwait     PendingAwait
	awaitResult        AwaitJobResult
}

func validateToolBatch(toolSet *ToolSet, calls []llm.ToolCall) ([]plannedCall, []missingCall) {
	planned := make([]plannedCall, 0, len(calls))
	missing := make([]missingCall, 0)

	for i, call := range calls {
		rawArgs := sanitizeToolArgs(call.Arguments)
		tool, ok := toolSet.Get(call.Name)
		if !ok {
			missing = append(missing, missingCall{index: i, call: call, rawArgs: rawArgs})
			continue
		}
		target, isDelegate := toolSet.DelegateTarget(call.Name)
		planned = append(planned, plannedCall{
			index:          i,
			call:           call,
			tool:           tool,
			rawArgs:        rawArgs,
			delegateTarget: target,
			isDelegate:     isDelegate,
		})
	}

	return planned, missing
}

func groupToolBatch(planned []plannedCall) []toolCallGroup {
	groups := make([]toolCallGroup, 0, len(planned))
	delegateGroups := make(map[string]int)

	for _, p := range planned {
		if p.isDelegate {
			if idx, ok := delegateGroups[p.delegateTarget]; ok {
				groups[idx].calls = append(groups[idx].calls, p)
				continue
			}
			delegateGroups[p.delegateTarget] = len(groups)
		}
		groups = append(groups, toolCallGroup{calls: []plannedCall{p}})
	}

	return groups
}

func runToolBatch(
	ctx context.Context,
	runCtx RunContext,
	sink EventSink,
	step int,
	planned []plannedCall,
	logger *slog.Logger,
) []toolOutcome {
	outcomeSlots := len(planned)
	for _, p := range planned {
		if p.index+1 > outcomeSlots {
			outcomeSlots = p.index + 1
		}
	}
	outcomes := make([]toolOutcome, outcomeSlots)
	groups := groupToolBatch(planned)

	var wg sync.WaitGroup
	wg.Add(len(groups))
	for _, group := range groups {
		group := group
		go func() {
			defer wg.Done()
			for _, p := range group.calls {
				if ctx.Err() != nil {
					return
				}
				outcomes[p.index] = runToolCall(ctx, runCtx, sink, step, p, logger)
			}
		}()
	}
	wg.Wait()

	return outcomes
}

func runToolCall(
	ctx context.Context,
	runCtx RunContext,
	sink EventSink,
	step int,
	p plannedCall,
	logger *slog.Logger,
) (outcome toolOutcome) {
	call := p.call
	outcome = toolOutcome{
		index:    p.index,
		toolName: call.Name,
	}

	logger.Info("executing tool", "tool", call.Name, "call_id", call.ID)
	sink.Emit(StreamEvent{
		Type: EventToolStarted,
		Tool: &ToolMeta{ID: call.ID, Name: call.Name, Args: p.rawArgs},
		Step: step,
	})
	sink.Emit(StreamEvent{Type: EventStatusUpdated, Status: fmt.Sprintf("Using %s", call.Name), Step: step})

	start := time.Now()
	var toolCancel context.CancelFunc
	defer func() {
		if toolCancel != nil {
			toolCancel()
		}
		if rec := recover(); rec != nil {
			latencyMs := time.Since(start).Milliseconds()
			errText := fmt.Sprintf("panic: %v", rec)
			logger.Error("tool execution panicked",
				"tool", call.Name,
				"call_id", call.ID,
				"error", rec,
				"stack", string(debug.Stack()),
			)
			outcome = failedToolOutcome(p, latencyMs, errText)
			sink.Emit(StreamEvent{
				Type:       EventToolFailed,
				Step:       step,
				Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: p.rawArgs},
				Error:      &ErrMeta{Code: "tool.execution_failed", Message: errText},
				DurationMs: latencyMs,
			})
		}
	}()

	toolTimeout := 30 * time.Second
	inheritCtx := false
	if tt, ok := p.tool.(tools.TimeoutTool); ok {
		if d := tt.Timeout(); d > 0 {
			toolTimeout = d
		} else {
			inheritCtx = true
		}
	}

	var toolCtx context.Context
	if inheritCtx {
		toolCtx, toolCancel = context.WithCancel(ctx)
	} else {
		toolCtx, toolCancel = context.WithTimeout(ctx, toolTimeout)
	}
	toolCtx = runtimectx.WithMemoryScope(toolCtx, runCtx.Memory)
	toolCtx = runtimectx.WithDelegation(toolCtx, runtimectx.DelegationInfo{
		OriginatorRunID: runCtx.OriginatorRunID,
		RunID:           runCtx.RunID,
		Chain:           runCtx.DelegationChain,
		Depth:           runCtx.DelegationDepth,
		UserID:          runCtx.Memory.UserID,
	})
	toolCtx = withAsyncRunInfo(toolCtx, asyncRunInfoForToolContext(runCtx))

	toolResult, err := p.tool.Execute(toolCtx, tools.ToolCall{
		ID:    call.ID,
		RunID: runCtx.RunID,
		Args:  call.Arguments,
	})
	toolCancel()
	toolCancel = nil

	latencyMs := time.Since(start).Milliseconds()

	if err != nil {
		errText := err.Error()
		logger.Error("tool execution failed", "tool", call.Name, "error", err)
		outcome = failedToolOutcome(p, latencyMs, errText)
		sink.Emit(StreamEvent{
			Type:       EventToolFailed,
			Step:       step,
			Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: p.rawArgs},
			Error:      &ErrMeta{Code: "tool.execution_failed", Message: errText},
			DurationMs: latencyMs,
		})
		return outcome
	}
	if toolResult == nil {
		errText := "tool returned nil result"
		logger.Error("tool execution failed", "tool", call.Name, "error", errText)
		outcome = failedToolOutcome(p, latencyMs, errText)
		sink.Emit(StreamEvent{
			Type:       EventToolFailed,
			Step:       step,
			Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: p.rawArgs},
			Error:      &ErrMeta{Code: "tool.execution_failed", Message: errText},
			DurationMs: latencyMs,
		})
		return outcome
	}

	if pending, _ := toolResult.Metadata[awaitMetadataPending].(bool); pending {
		jobID, _ := toolResult.Metadata[awaitMetadataJobID].(string)
		delegateTool, _ := toolResult.Metadata[awaitMetadataDelegateTool].(string)
		createdAt, _ := toolResult.Metadata[awaitMetadataCreatedAt].(time.Time)
		if createdAt.IsZero() {
			createdAt = time.Now()
		}
		logger.Info("await_job pending", "job_id", jobID, "call_id", call.ID)
		return toolOutcome{
			index:        p.index,
			toolName:     call.Name,
			awaitPending: true,
			pendingAwait: PendingAwait{
				JobID:           jobID,
				AwaitToolCallID: call.ID,
				CreatedAt:       createdAt,
				DelegateTool:    delegateTool,
			},
			ran: true,
		}
	}

	content := truncateToolContent(toolResult.Content)
	logger.Info("tool completed",
		"tool", call.Name,
		"is_error", toolResult.IsError,
		"content_len", len(content),
		"latency_ms", latencyMs)

	toolMsg := llm.ChatMessage{
		Role:       "tool",
		ToolCallID: call.ID,
		Content:    content,
		Metadata: map[string]any{
			"tool_name":  call.Name,
			"arguments":  string(call.Arguments),
			"is_error":   toolResult.IsError,
			"latency_ms": latencyMs,
		},
	}
	outcome = toolOutcome{
		index:      p.index,
		toolName:   call.Name,
		message:    toolMsg,
		lastAction: fmt.Sprintf("%s → success", call.Name),
		ran:        true,
	}
	if toolResult.IsError {
		outcome.lastAction = fmt.Sprintf("%s → error", call.Name)
	}
	if terminal, _ := toolResult.Metadata[awaitMetadataTerminal].(bool); terminal {
		jobID, _ := toolResult.Metadata[awaitMetadataJobID].(string)
		delegateTool, _ := toolResult.Metadata[awaitMetadataDelegateTool].(string)
		status, _ := toolResult.Metadata[awaitMetadataStatus].(string)
		output, _ := toolResult.Metadata[awaitMetadataOutput].(string)
		errText, _ := toolResult.Metadata[awaitMetadataError].(string)
		createdAt, _ := toolResult.Metadata[awaitMetadataCreatedAt].(time.Time)
		if createdAt.IsZero() {
			createdAt = time.Now()
		}
		outcome.awaitDelivered = true
		outcome.deliveredAwait = PendingAwait{
			JobID:           jobID,
			AwaitToolCallID: call.ID,
			CreatedAt:       createdAt,
			DelegateTool:    delegateTool,
		}
		outcome.awaitResult = AwaitJobResult{
			JobID:        jobID,
			Status:       status,
			Output:       output,
			Error:        errText,
			CreatedAt:    createdAt,
			DelegateTool: delegateTool,
		}
	}

	displayStr := fmt.Sprintf("Finished %s", call.Name)
	if content != "" && len(content) < 50 {
		displayStr = fmt.Sprintf("Result: %s", content)
	}
	if toolResult.IsError {
		displayStr = fmt.Sprintf("Error in %s", call.Name)
	}

	if dispatched, _ := toolResult.Metadata["job_dispatched"].(bool); dispatched {
		jobID, _ := toolResult.Metadata["job_id"].(string)
		status, _ := toolResult.Metadata["job_status"].(string)
		mode, _ := toolResult.Metadata["job_mode"].(string)
		delegateTool, _ := toolResult.Metadata["delegate_tool"].(string)
		target, _ := toolResult.Metadata["target_agent_id"].(string)
		sink.Emit(StreamEvent{
			Type: EventJobDispatched,
			Step: step,
			Job:  &JobMeta{ID: jobID, Status: status, Mode: mode, DelegateTool: delegateTool, TargetAgentID: target},
		})
	}

	sink.Emit(StreamEvent{
		Type:       EventToolCompleted,
		Step:       step,
		Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: p.rawArgs, Display: displayStr},
		DurationMs: latencyMs,
	})

	return outcome
}

func applyToolOutcomes(
	messages *[]llm.ChatMessage,
	newMessages *[]llm.ChatMessage,
	toolFailures map[string]int,
	runCtx *RunContext,
	outcomes []toolOutcome,
) error {
	var thresholdErr error

	for _, outcome := range outcomes {
		if !outcome.ran {
			continue
		}
		if outcome.awaitPending {
			continue
		}
		*messages = append(*messages, outcome.message)
		*newMessages = append(*newMessages, outcome.message)
		if outcome.lastAction != "" {
			runCtx.LastAction = outcome.lastAction
		}
		if !outcome.execFailed {
			continue
		}
		toolFailures[outcome.toolName]++
		if toolFailures[outcome.toolName] >= 3 && thresholdErr == nil {
			thresholdErr = fmt.Errorf(
				"tool %q exceeded failure threshold: %s",
				outcome.toolName,
				outcome.thresholdErrorText,
			)
		}
	}

	return thresholdErr
}

func failedToolOutcome(p plannedCall, latencyMs int64, errText string) toolOutcome {
	call := p.call
	msg := llm.ChatMessage{
		Role:       "tool",
		ToolCallID: call.ID,
		Content:    fmt.Sprintf("[error] tool %q failed: %s", call.Name, errText),
		Metadata: map[string]any{
			"tool_name":  call.Name,
			"arguments":  string(call.Arguments),
			"is_error":   true,
			"latency_ms": latencyMs,
		},
	}
	return toolOutcome{
		index:              p.index,
		toolName:           call.Name,
		message:            msg,
		execFailed:         true,
		thresholdErrorText: errText,
		lastAction:         fmt.Sprintf("%s → error", call.Name),
		ran:                true,
	}
}

// softMissingMCPOutcome synthesizes a degraded tool result for an mcp__* call
// whose server is unavailable (e.g. a pending call restored on resume after the
// server went down). It is a SOFT error: the model sees it and can adapt, the
// transcript stays consistent (every tool_call_id gets a result), and it does
// NOT count toward the failure threshold (execFailed stays false).
func softMissingMCPOutcome(m missingCall) toolOutcome {
	call := m.call
	return toolOutcome{
		index:    m.index,
		toolName: call.Name,
		message: llm.ChatMessage{
			Role:       "tool",
			ToolCallID: call.ID,
			Content:    fmt.Sprintf("[error] MCP tool %q is unavailable this run (its server could not be reached); it cannot be called now.", call.Name),
			Metadata: map[string]any{
				"tool_name": call.Name,
				"arguments": string(call.Arguments),
				"is_error":  true,
			},
		},
		lastAction: fmt.Sprintf("%s → unavailable", call.Name),
		ran:        true,
	}
}

func sanitizeToolArgs(args json.RawMessage) json.RawMessage {
	if json.Valid(args) {
		return args
	}
	b, err := json.Marshal(string(args))
	if err != nil {
		return json.RawMessage(`""`)
	}
	return json.RawMessage(b)
}

func truncateToolContent(content string) string {
	if len(content) <= 8000 {
		return content
	}
	r := []rune(content)
	if len(r) <= 8000 {
		return content
	}
	return string(r[:8000]) + "\n\n...(truncated due to length limit)"
}
