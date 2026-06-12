package agent

import (
	"backend/llm"
	"backend/model"
	"backend/tools"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sort"
	"strings"
	"time"
)

const checkpointFailureThreshold = 3

type AgentRuntime struct {
	llmRegistry     *llm.LLMRegistry
	toolRegistry    *tools.ToolRegistry
	contextBuilder  *ContextBuilder
	checkpointStore CheckpointStore
	delegateInvoker DelegateInvoker
	asyncJobs       AsyncJobStore
}

func NewAgentRuntime(
	llmRegistry *llm.LLMRegistry,
	toolRegistry *tools.ToolRegistry,
	contextBuilder *ContextBuilder,
) *AgentRuntime {
	return &AgentRuntime{
		llmRegistry:    llmRegistry,
		toolRegistry:   toolRegistry,
		contextBuilder: contextBuilder,
	}
}

func (r *AgentRuntime) WithCheckpointStore(store CheckpointStore) *AgentRuntime {
	return &AgentRuntime{
		llmRegistry:     r.llmRegistry,
		toolRegistry:    r.toolRegistry,
		contextBuilder:  r.contextBuilder,
		checkpointStore: store,
		delegateInvoker: r.delegateInvoker,
		asyncJobs:       r.asyncJobs,
	}
}

// SetDelegateInvoker wires the delegate invoker after construction (the
// invoker depends on the pool manager, which depends on the runtime — so it
// can't be a constructor arg). Required before running any agent that has
// Delegates configured; BuildToolSet fails fast otherwise.
func (r *AgentRuntime) SetDelegateInvoker(inv DelegateInvoker) {
	r.delegateInvoker = inv
}

func (r *AgentRuntime) SetAsyncJobStore(store AsyncJobStore) {
	r.asyncJobs = store
}

func (r *AgentRuntime) Run(ctx context.Context, agent *Agent, runCtx RunContext) (*RunResult, error) {
	return r.runInternal(ctx, agent, runCtx, &NoopSink{})
}

// EstimateSystemPromptTokens returns an approximate token cost for the
// system message that ContextBuilder would assemble for (agent, runCtx).
// It is the accurate input to summarization decisions: callers that have
// access to the runtime should use this instead of the fallback heuristic
// in agent.ShouldSummarize.
func (r *AgentRuntime) EstimateSystemPromptTokens(ctx context.Context, agent *Agent, runCtx RunContext) int {
	if r.contextBuilder == nil {
		return 0
	}
	toolSet, err := BuildToolSetForValidation(r.toolRegistry, agent)
	if err != nil {
		return 0
	}
	return r.contextBuilder.EstimateSystemPromptTokens(ctx, agent, runCtx, toolSet.Definitions())
}

func (r *AgentRuntime) RunStream(ctx context.Context, ag *Agent, runCtx RunContext, events chan<- StreamEvent) (*RunResult, error) {
	sink := NewChannelSink(ctx, runCtx.RunID, events)
	return r.runInternal(ctx, ag, runCtx, sink)
}

type terminalState int

const (
	stateFailed terminalState = iota
	stateSuccess
	stateCancelled
	stateWaiting
)

func (r *AgentRuntime) runInternal(ctx context.Context, agent *Agent, runCtx RunContext, sink EventSink) (result *RunResult, err error) {
	logger := runCtx.Logger
	if logger == nil {
		logger = slog.Default()
	}

	state := stateFailed
	runStart := time.Now()
	var hasSnapshot bool

	sink.Emit(StreamEvent{
		Type:     EventRunStarted,
		Provider: agent.Provider,
		Model:    agent.Model,
	})

	defer func() {
		var panicStackTrace string
		if rec := recover(); rec != nil {
			panicStackTrace = string(debug.Stack())
			logger.Error("panic recovered", "error", rec, "stack", panicStackTrace)
			err = fmt.Errorf("panic in runtime: %v", rec)
			state = stateFailed
		}

		if err == nil && result == nil {
			err = fmt.Errorf("internal logic error: result is nil on success")
			state = stateFailed
		}

		duration := time.Since(runStart).Milliseconds()

		switch state {
		case stateSuccess:
			sink.Emit(StreamEvent{
				Type:       EventRunCompleted,
				DurationMs: duration,
				Content:    result.Output,
				Usage:      &result.Usage,
				Step:       result.Steps,
			})
		case stateCancelled:
			sink.Emit(StreamEvent{Type: EventRunCancelled, DurationMs: duration})
		case stateWaiting:
			sink.Emit(StreamEvent{Type: EventRunWaiting, DurationMs: duration, Step: result.Steps})
		case stateFailed:
			errMsg := "unknown error"
			if err != nil {
				errMsg = err.Error()
			}
			sink.Emit(StreamEvent{
				Type:       EventRunFailed,
				DurationMs: duration,
				Error:      &ErrMeta{Code: classifyError(err), Message: errMsg},
			})
		}

		if r.checkpointStore != nil {
			runID := runCtx.RunID
			switch state {
			case stateSuccess:
				_ = r.checkpointStore.UpdateStatus(context.Background(), runID, "completed", "")
			case stateCancelled:
				if hasSnapshot {
					_ = r.checkpointStore.UpdateStatus(context.Background(), runID, string(model.RunStatusInterrupted), "")
				} else {
					_ = r.checkpointStore.UpdateStatus(context.Background(), runID, string(model.RunStatusFailed), "interrupted before first checkpoint")
				}
			case stateWaiting:
				_ = r.checkpointStore.UpdateStatus(context.Background(), runID, string(model.RunStatusWaitingJobs), "")
			case stateFailed:
				errMsg := "unknown error"
				if err != nil {
					errMsg = err.Error()
				}
				if IsResumable(err) && hasSnapshot {
					_ = r.checkpointStore.UpdateStatus(context.Background(), runID, "resumable", errMsg)
				} else {
					_ = r.checkpointStore.UpdateStatus(context.Background(), runID, "failed", errMsg)
				}
			}
		}

		sink.Close()
	}()

	maxSteps := agent.MaxSteps
	if maxSteps == 0 {
		maxSteps = DefaultMaxSteps
	}

	client, err := r.llmRegistry.Get(agent.Provider)
	if err != nil {
		err = fmt.Errorf("llm registry: %w", err)
		return nil, err
	}

	toolSet, err := BuildToolSet(r.toolRegistry, r.delegateInvoker, agent, r.asyncJobs)
	if err != nil {
		return nil, err
	}
	toolDefs := toolSet.Definitions()

	var (
		messages           []llm.ChatMessage
		newMessages        []llm.ChatMessage
		totalUsage         llm.TokenUsage
		steps              int
		toolFailures       map[string]int
		checkpointFailures int
		pendingToolCalls   []llm.ToolCall
		pendingAwaits      []PendingAwait
	)

	if runCtx.Checkpoint != nil {
		s := runCtx.Checkpoint.State
		steps = s.StepsCompleted
		totalUsage = s.TotalUsage
		toolFailures = s.ToolFailures
		pendingAwaits = s.PendingAwaits
		if toolFailures == nil {
			toolFailures = make(map[string]int)
		}
		newMessages = make([]llm.ChatMessage, 0)
		hasSnapshot = true

		// Promote snapshot state into runCtx so the ContextBuilder renders
		// <state> with the correct phase / step counter, and recover a
		// best-effort LastAction from the most recent tool message so that
		// a resumed run still surfaces what just happened.
		runCtx.Phase = runCtx.Checkpoint.Meta.Phase
		runCtx.StepsCompleted = s.StepsCompleted
		if strings.TrimSpace(runCtx.Summary) == "" {
			runCtx.Summary = s.RawSummary
		}
		if runCtx.LastAction == "" {
			runCtx.LastAction = deriveLastActionFromMessages(s.Messages)
		}
		// Restore delegation lineage so a resumed delegated run can itself
		// delegate with the correct chain/depth.
		if runCtx.OriginatorRunID == "" {
			runCtx.OriginatorRunID = runCtx.Checkpoint.Meta.OriginatorRunID
		}
		if runCtx.ParentRunID == "" {
			runCtx.ParentRunID = runCtx.Checkpoint.Meta.ParentRunID
		}
		if len(runCtx.DelegationChain) == 0 {
			runCtx.DelegationChain = runCtx.Checkpoint.Meta.DelegationChain
		}
		if runCtx.DelegationDepth == 0 {
			runCtx.DelegationDepth = runCtx.Checkpoint.Meta.DelegationDepth
		}
		if runCtx.InvocationKind == "" {
			runCtx.InvocationKind = runCtx.Checkpoint.Meta.InvocationKind
		}
		if runCtx.JobID == "" {
			runCtx.JobID = runCtx.Checkpoint.Meta.JobID
		}
		if runCtx.SystemContext == "" {
			runCtx.SystemContext = runCtx.Checkpoint.Meta.SystemContext
		}

		sink.Emit(StreamEvent{
			Type:    EventRunResumed,
			Step:    steps,
			Attempt: runCtx.Checkpoint.Meta.Attempt,
		})
	} else {
		if runCtx.Phase == "" {
			runCtx.Phase = PhasePreModel
		}
		newMessages = make([]llm.ChatMessage, 0)
		toolFailures = make(map[string]int)
	}

	// Default delegation lineage for top-level runs (and legacy snapshots
	// with no tree fields): originator is the run itself, chain starts at
	// this agent, depth 0.
	if runCtx.OriginatorRunID == "" {
		runCtx.OriginatorRunID = runCtx.RunID
	}
	if len(runCtx.DelegationChain) == 0 {
		runCtx.DelegationChain = []string{agent.ID}
	}
	if runCtx.InvocationKind == "" {
		if runCtx.ParentRunID != "" {
			runCtx.InvocationKind = InvocationSyncDelegate
		} else {
			runCtx.InvocationKind = InvocationTopLevel
		}
	}

	if r.contextBuilder == nil {
		return nil, fmt.Errorf("runtime: context builder is not configured")
	}
	messages, err = r.contextBuilder.Build(ctx, agent, runCtx, toolDefs)
	if err != nil {
		return nil, fmt.Errorf("runtime: context build: %w", err)
	}

	if runCtx.Checkpoint != nil && runCtx.Checkpoint.Meta.Phase == PhasePostModel {
		if len(messages) == 0 || messages[len(messages)-1].Role != "assistant" {
			return nil, fmt.Errorf(
				"post_model resume: snapshot missing assistant message with tool calls",
			)
		}
		pendingToolCalls = messages[len(messages)-1].ToolCalls
		if len(pendingToolCalls) == 0 {
			return nil, fmt.Errorf("post_model resume: no pending tool calls")
		}
	}

	if runCtx.Checkpoint != nil && runCtx.Checkpoint.Meta.Phase == PhaseWaitingJobs {
		if len(pendingAwaits) == 0 {
			return nil, fmt.Errorf("waiting_for_jobs resume: no pending awaits")
		}
		waitingAgain, waitErr := r.resumePendingAwaits(
			ctx, &runCtx, sink, steps, &messages, &newMessages,
			pendingAwaits, logger,
		)
		if waitErr != nil {
			state = stateFailed
			return nil, waitErr
		}
		if waitingAgain {
			state = stateWaiting
			return &RunResult{
				Status:      RunResultWaiting,
				NewMessages: newMessages,
				Steps:       steps,
				Usage:       totalUsage,
			}, nil
		}
		pendingAwaits = nil
	}

	for steps < maxSteps {
		if ctx.Err() != nil {
			state = stateCancelled
			return nil, ctx.Err()
		}

		var toolCalls []llm.ToolCall

		if pendingToolCalls != nil {
			toolCalls = pendingToolCalls
			pendingToolCalls = nil
			logger.Info("resuming from post_model snapshot",
				"pending_tool_calls", len(toolCalls))
		} else {
			if r.checkpointStore != nil {
				snapshot := buildSnapshot(
					runCtx, agent, messages, runCtx.Summary, steps, maxSteps,
					totalUsage, toolFailures, checkpointFailures, PhasePreModel, nil, toolSet,
				)
				var saveErr error
				if checkpointFailures, saveErr = r.trySaveCheckpoint(snapshot, sink, steps, checkpointFailures, hasSnapshot, logger); saveErr != nil {
					state = stateFailed
					return nil, saveErr
				}
				hasSnapshot = true
			}

			sink.Emit(StreamEvent{Type: EventStepStarted, Step: steps + 1, MaxSteps: maxSteps})
			sink.Emit(StreamEvent{Type: EventStatusUpdated, Status: "Calling model", Step: steps + 1})

			logger.Info("calling model",
				"step", steps+1,
				"model", agent.Model,
				"messages", len(messages))

			temperature := agent.Temperature
			if temperature == 0 {
				temperature = DefaultTemperature
			}
			maxTokens := agent.MaxTokens
			if maxTokens == 0 {
				maxTokens = DefaultMaxTokens
			}

			// Refresh the system message with the live <state> block before
			// every call so step / phase / last_action are not stale across
			// iterations. The static prefix stays byte-identical for caching.
			runCtx.Phase = PhasePreModel
			runCtx.StepsCompleted = steps
			sysContent, sysErr := r.contextBuilder.BuildSystemContent(ctx, agent, runCtx, toolDefs)
			if sysErr != nil {
				return nil, fmt.Errorf("runtime: refresh system message: %w", sysErr)
			}
			messages[0] = llm.ChatMessage{Role: "system", Content: sysContent}

			// Apply display-only tool-result truncation to a copy. The
			// canonical `messages` slice stays untruncated so checkpoints
			// preserve full evidence across resumes.
			forLLM := r.contextBuilder.RenderForLLM(messages)

			resp, err := client.ChatCompletion(ctx, &llm.ChatRequest{
				Model:       agent.Model,
				Messages:    forLLM,
				Tools:       toolDefs,
				Temperature: temperature,
				MaxTokens:   maxTokens,
			})

			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
					state = stateCancelled
					return nil, err
				}
				return nil, fmt.Errorf("runtime: llm call failed at step %d: %w", steps+1, err)
			}

			steps++
			sink.Emit(StreamEvent{Type: EventModelCompleted, Step: steps})

			totalUsage.PromptTokens += resp.Usage.PromptTokens
			totalUsage.CompletionTokens += resp.Usage.CompletionTokens
			totalUsage.TotalTokens += resp.Usage.TotalTokens

			if len(resp.ToolCalls) == 0 {
				autoCalls, err := r.buildAutoAwaitCalls(ctx, runCtx)
				if err != nil {
					state = stateFailed
					return nil, err
				}
				if len(autoCalls) > 0 {
					logger.Info("auto-awaiting required jobs", "count", len(autoCalls))
					assistantMsg := llm.ChatMessage{
						Role:      "assistant",
						ToolCalls: autoCalls,
						Metadata:  map[string]any{"synthetic": "auto_await"},
					}
					messages = append(messages, assistantMsg)
					newMessages = append(newMessages, assistantMsg)

					if r.checkpointStore != nil {
						snapshot := buildSnapshot(
							runCtx, agent, messages, runCtx.Summary, steps, maxSteps,
							totalUsage, toolFailures, checkpointFailures, PhasePostModel, nil, toolSet,
						)
						var saveErr error
						if checkpointFailures, saveErr = r.trySaveCheckpoint(snapshot, sink, steps, checkpointFailures, hasSnapshot, logger); saveErr != nil {
							state = stateFailed
							return nil, saveErr
						}
						hasSnapshot = true
					}
					toolCalls = autoCalls
				} else {
					output := strings.TrimSpace(resp.Content)
					if output == "" {
						state = stateFailed
						return nil, ErrNoFinalOutput
					}

					finalMsg := llm.ChatMessage{Role: "assistant", Content: resp.Content}
					messages = append(messages, finalMsg)
					newMessages = append(newMessages, finalMsg)

					logger.Info("run completed",
						"steps", steps,
						"prompt_tokens", totalUsage.PromptTokens,
						"completion_tokens", totalUsage.CompletionTokens)

					sink.Emit(StreamEvent{Type: EventStepCompleted, Step: steps})

					if r.checkpointStore != nil {
						snapshot := buildSnapshot(
							runCtx, agent, messages, runCtx.Summary, steps, maxSteps,
							totalUsage, toolFailures, checkpointFailures, PhaseStepCompleted, nil, toolSet,
						)
						var saveErr error
						if checkpointFailures, saveErr = r.trySaveCheckpoint(snapshot, sink, steps, checkpointFailures, hasSnapshot, logger); saveErr != nil {
							state = stateFailed
							return nil, saveErr
						}
						hasSnapshot = true
					}

					state = stateSuccess
					return &RunResult{
						Status:      RunResultCompleted,
						Output:      output,
						NewMessages: newMessages,
						Steps:       steps,
						Usage:       totalUsage,
					}, nil
				}
			}

			if len(resp.ToolCalls) > 0 {
				logger.Info("model returned tool calls",
					"step", steps,
					"tool_calls", len(resp.ToolCalls))

				assistantMsg := llm.ChatMessage{
					Role:      "assistant",
					Content:   resp.Content,
					ToolCalls: resp.ToolCalls,
				}
				messages = append(messages, assistantMsg)
				newMessages = append(newMessages, assistantMsg)

				if r.checkpointStore != nil {
					snapshot := buildSnapshot(
						runCtx, agent, messages, runCtx.Summary, steps, maxSteps,
						totalUsage, toolFailures, checkpointFailures, PhasePostModel, nil, toolSet,
					)
					var saveErr error
					if checkpointFailures, saveErr = r.trySaveCheckpoint(snapshot, sink, steps, checkpointFailures, hasSnapshot, logger); saveErr != nil {
						state = stateFailed
						return nil, saveErr
					}
					hasSnapshot = true
				}

				toolCalls = resp.ToolCalls
			}
		}

		planned, missing := validateToolBatch(toolSet, toolCalls)
		if len(missing) > 0 {
			for _, m := range missing {
				logger.Error("tool not found, aborting", "tool", m.call.Name)
				sink.Emit(StreamEvent{
					Type:  EventToolFailed,
					Tool:  &ToolMeta{ID: m.call.ID, Name: m.call.Name, Args: m.rawArgs},
					Error: &ErrMeta{Code: "tool.not_found", Message: "tool not available"},
					Step:  steps,
				})
			}
			return nil, fmt.Errorf("%w: %s", ErrToolNotAvailable, missing[0].call.Name)
		}
		if ctx.Err() != nil {
			state = stateCancelled
			return nil, ctx.Err()
		}

		outcomes := runToolBatch(ctx, runCtx, sink, steps, planned, logger)
		if ctx.Err() != nil {
			state = stateCancelled
			return nil, ctx.Err()
		}

		if err := applyToolOutcomes(&messages, &newMessages, toolFailures, &runCtx, outcomes); err != nil {
			state = stateFailed
			return nil, err
		}
		deliveredResults, deliveredAwaits := collectDeliveredAwaits(outcomes)
		if len(deliveredResults) > 0 {
			if r.asyncJobs == nil {
				state = stateFailed
				return nil, fmt.Errorf("runtime: async job store is not configured")
			}
			if err := r.asyncJobs.MarkDelivered(ctx, runCtx.RunID, runCtx.Memory.UserID, deliveredResults, deliveredAwaits); err != nil {
				state = stateFailed
				return nil, err
			}
		}
		pendingAwaits = collectPendingAwaits(outcomes)
		if len(pendingAwaits) > 0 {
			if r.asyncJobs == nil {
				state = stateFailed
				return nil, fmt.Errorf("runtime: async job store is not configured")
			}
			if r.checkpointStore == nil {
				state = stateFailed
				return nil, fmt.Errorf("runtime: checkpoint store is required for waiting_for_jobs")
			}
			if err := r.asyncJobs.MarkAwaiting(ctx, runCtx.RunID, pendingAwaits); err != nil {
				state = stateFailed
				return nil, err
			}
			if r.checkpointStore != nil {
				snapshot := buildSnapshot(
					runCtx, agent, messages, runCtx.Summary, steps, maxSteps,
					totalUsage, toolFailures, checkpointFailures, PhaseWaitingJobs, pendingAwaits, toolSet,
				)
				var saveErr error
				if checkpointFailures, saveErr = r.trySaveCheckpoint(snapshot, sink, steps, checkpointFailures, hasSnapshot, logger); saveErr != nil {
					state = stateFailed
					return nil, saveErr
				}
				hasSnapshot = true
			}
			state = stateWaiting
			return &RunResult{
				Status:      RunResultWaiting,
				NewMessages: newMessages,
				Steps:       steps,
				Usage:       totalUsage,
			}, nil
		}
		sink.Emit(StreamEvent{Type: EventStepCompleted, Step: steps})
	}

	logger.Warn("max steps reached", "steps", steps)
	return nil, ErrMaxStepsReached
}

func classifyError(err error) string {
	if err == nil {
		return "engine.runtime_error"
	}
	switch {
	case errors.Is(err, ErrMaxStepsReached):
		return "engine.max_steps"
	case errors.Is(err, ErrNoFinalOutput):
		return "engine.no_output"
	case errors.Is(err, ErrToolNotAvailable):
		return "tool.not_found"
	case errors.Is(err, context.Canceled):
		return "engine.cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "engine.timeout"
	default:
		if strings.Contains(err.Error(), "panic in runtime") {
			return "engine.panic"
		}
		if strings.Contains(err.Error(), "llm registry") {
			return "provider.unavailable"
		}
		return "engine.runtime_error"
	}
}

// deriveLastActionFromMessages walks the snapshot messages newest-first and
// returns a short description of the most recent tool execution, e.g.
// "calculator → success" or "memory_write → error". Returns "" when no tool
// message is present (typical of a fresh pre_model snapshot).
//
// Used on resume to repopulate runCtx.LastAction so the model still sees what
// happened just before the interruption.
func deriveLastActionFromMessages(messages []llm.ChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != "tool" {
			continue
		}
		toolName, _ := m.Metadata["tool_name"].(string)
		if toolName == "" {
			toolName = "tool"
		}
		outcome := "success"
		if isErr, ok := m.Metadata["is_error"].(bool); ok && isErr {
			outcome = "error"
		} else if strings.HasPrefix(m.Content, "[error]") {
			outcome = "error"
		}
		return fmt.Sprintf("%s → %s", toolName, outcome)
	}
	return ""
}

func collectPendingAwaits(outcomes []toolOutcome) []PendingAwait {
	var awaits []PendingAwait
	for _, outcome := range outcomes {
		if !outcome.awaitPending {
			continue
		}
		awaits = append(awaits, outcome.pendingAwait)
	}
	sortPendingAwaits(awaits)
	return awaits
}

func collectDeliveredAwaits(outcomes []toolOutcome) ([]AwaitJobResult, []PendingAwait) {
	var results []AwaitJobResult
	var awaits []PendingAwait
	for _, outcome := range outcomes {
		if !outcome.awaitDelivered {
			continue
		}
		results = append(results, outcome.awaitResult)
		awaits = append(awaits, outcome.deliveredAwait)
	}
	return results, awaits
}

func sortPendingAwaits(awaits []PendingAwait) {
	sort.SliceStable(awaits, func(i, j int) bool {
		if awaits[i].CreatedAt.Equal(awaits[j].CreatedAt) {
			return awaits[i].JobID < awaits[j].JobID
		}
		return awaits[i].CreatedAt.Before(awaits[j].CreatedAt)
	})
}

func (r *AgentRuntime) buildAutoAwaitCalls(ctx context.Context, runCtx RunContext) ([]llm.ToolCall, error) {
	if r.asyncJobs == nil {
		return nil, nil
	}
	jobs, err := r.asyncJobs.PendingRequiredJobs(ctx, runCtx.RunID, runCtx.Memory.UserID)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(jobs, func(i, j int) bool {
		if jobs[i].CreatedAt.Equal(jobs[j].CreatedAt) {
			return jobs[i].JobID < jobs[j].JobID
		}
		return jobs[i].CreatedAt.Before(jobs[j].CreatedAt)
	})
	calls := make([]llm.ToolCall, 0, len(jobs))
	for _, job := range jobs {
		args, _ := json.Marshal(map[string]string{"job_id": job.JobID})
		calls = append(calls, llm.ToolCall{
			ID:        "auto-await:" + runCtx.RunID + ":" + job.JobID,
			Name:      AsyncToolAwaitJob,
			Arguments: args,
		})
	}
	return calls, nil
}

func (r *AgentRuntime) resumePendingAwaits(
	ctx context.Context,
	runCtx *RunContext,
	sink EventSink,
	step int,
	messages *[]llm.ChatMessage,
	newMessages *[]llm.ChatMessage,
	awaits []PendingAwait,
	logger *slog.Logger,
) (bool, error) {
	if r.asyncJobs == nil {
		return false, fmt.Errorf("runtime: async job store is not configured")
	}
	sortPendingAwaits(awaits)
	results, allTerminal, err := r.asyncJobs.ResolveAwaits(ctx, runCtx.RunID, runCtx.Memory.UserID, awaits)
	if err != nil {
		return false, err
	}
	if !allTerminal {
		if err := r.asyncJobs.MarkAwaiting(ctx, runCtx.RunID, awaits); err != nil {
			return false, err
		}
		return true, nil
	}
	if err := r.asyncJobs.MarkDelivered(ctx, runCtx.RunID, runCtx.Memory.UserID, results, awaits); err != nil {
		return false, err
	}
	for i, res := range results {
		await := awaits[i]
		toolResult, _ := awaitResultToToolResult(res)
		content := truncateToolContent(toolResult.Content)
		isErr := toolResult.IsError
		args, _ := json.Marshal(map[string]string{"job_id": res.JobID})
		latencyMs := int64(0)
		msg := llm.ChatMessage{
			Role:       "tool",
			ToolCallID: await.AwaitToolCallID,
			Content:    content,
			Metadata: map[string]any{
				"tool_name":  AsyncToolAwaitJob,
				"arguments":  string(args),
				"is_error":   isErr,
				"latency_ms": latencyMs,
				"job_id":     res.JobID,
			},
		}
		*messages = append(*messages, msg)
		*newMessages = append(*newMessages, msg)
		runCtx.LastAction = AsyncToolAwaitJob + " → success"
		display := "Finished await_job"
		if isErr {
			runCtx.LastAction = AsyncToolAwaitJob + " → error"
			display = "Error in await_job"
		}
		sink.Emit(StreamEvent{
			Type:       EventToolCompleted,
			Step:       step,
			Tool:       &ToolMeta{ID: await.AwaitToolCallID, Name: AsyncToolAwaitJob, Args: args, Display: display},
			DurationMs: latencyMs,
		})
		logger.Info("await_job resolved", "job_id", res.JobID, "status", res.Status)
	}
	return false, nil
}

func buildSnapshot(
	runCtx RunContext, ag *Agent, messages []llm.ChatMessage, summary string,
	steps, maxSteps int, usage llm.TokenUsage, toolFailures map[string]int,
	checkpointFailures int, phase string, pendingAwaits []PendingAwait, toolSet *ToolSet,
) RunSnapshot {

	return RunSnapshot{
		Version: 1,
		RunID:   runCtx.RunID,
		State: RuntimeState{
			Messages:       messages[1:],
			RawSummary:     summary,
			StepsCompleted: steps,
			MaxSteps:       maxSteps,
			TotalUsage:     usage,
			ToolFailures:   toolFailures,
			PendingAwaits:  pendingAwaits,
		},
		Meta: SnapshotMeta{
			AgentID:            ag.ID,
			ThreadID:           runCtx.ThreadID,
			Provider:           ag.Provider,
			Model:              ag.Model,
			Temperature:        ag.Temperature,
			ToolsetVersion:     toolSet.Version(),
			EffectiveTools:     toolSet.Refs(),
			Attempt:            runCtx.Attempt,
			Phase:              phase,
			CheckpointFailures: checkpointFailures,
			LastCheckpointAt:   time.Now(),
			CreatedAt:          time.Now(),
			OriginatorRunID:    runCtx.OriginatorRunID,
			ParentRunID:        runCtx.ParentRunID,
			DelegationChain:    runCtx.DelegationChain,
			DelegationDepth:    runCtx.DelegationDepth,
			InvocationKind:     runCtx.InvocationKind,
			JobID:              runCtx.JobID,
			SystemContext:      runCtx.SystemContext,
		},
	}
}

func (r *AgentRuntime) trySaveCheckpoint(
	snapshot RunSnapshot, sink EventSink, step, failures int, hasSnapshot bool, logger *slog.Logger,
) (int, error) {
	const (
		checkpointMaxAttempts    = 3
		checkpointPerAttemptTime = 1500 * time.Millisecond
		checkpointBaseBackoff    = 75 * time.Millisecond
	)

	var lastErr error
	for attempt := 0; attempt < checkpointMaxAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(checkpointBaseBackoff * (1 << (attempt - 1))) // 75ms, 150ms
		}
		saveCtx, cancel := context.WithTimeout(context.Background(), checkpointPerAttemptTime)
		lastErr = r.checkpointStore.Save(saveCtx, snapshot)
		cancel()
		if lastErr == nil {
			return 0, nil
		}
		logger.Warn("checkpoint write attempt failed",
			"step", step,
			"phase", snapshot.Meta.Phase,
			"attempt", attempt+1,
			"error", lastErr,
		)
	}

	failures++
	logger.Warn("checkpoint write failed after retries",
		"step", step,
		"phase", snapshot.Meta.Phase,
		"consecutive_failures", failures,
		"error", lastErr,
	)
	sink.Emit(StreamEvent{
		Type:   EventStatusUpdated,
		Status: "checkpoint write failed — durability degraded",
		Step:   step,
	})
	if failures >= checkpointFailureThreshold {
		if hasSnapshot {
			return failures, fmt.Errorf(
				"%w after %d consecutive failures",
				ErrCheckpointStoreUnavailable, failures,
			)
		}
		return failures, fmt.Errorf(
			"checkpoint store never available; cannot resume (%d consecutive failures)",
			failures,
		)
	}
	return failures, nil
}
