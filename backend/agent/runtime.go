package agent

import (
	"backend/llm"
	"backend/model"
	"backend/runtimectx"
	"backend/tools"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"time"
)

const checkpointFailureThreshold = 3

type AgentRuntime struct {
	llmRegistry     *llm.LLMRegistry
	toolRegistry    *tools.ToolRegistry
	checkpointStore CheckpointStore
}

func NewAgentRuntime(llmRegistry *llm.LLMRegistry, toolRegistry *tools.ToolRegistry) *AgentRuntime {
	return &AgentRuntime{
		llmRegistry:  llmRegistry,
		toolRegistry: toolRegistry,
	}
}

func (r *AgentRuntime) WithCheckpointStore(store CheckpointStore) *AgentRuntime {
	return &AgentRuntime{
		llmRegistry:     r.llmRegistry,
		toolRegistry:    r.toolRegistry,
		checkpointStore: store,
	}
}

func (r *AgentRuntime) Run(ctx context.Context, agent *Agent, runCtx RunContext) (*RunResult, error) {
	return r.runInternal(ctx, agent, runCtx, &NoopSink{})
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

	toolDefs, err := r.loadTools(agent)
	if err != nil {
		return nil, err
	}

	var (
		messages           []llm.ChatMessage
		newMessages        []llm.ChatMessage
		totalUsage         llm.TokenUsage
		steps              int
		toolFailures       map[string]int
		checkpointFailures int
		pendingToolCalls   []llm.ToolCall
	)

	if runCtx.Checkpoint != nil {
		s := runCtx.Checkpoint.State
		messages = s.Messages
		systemMsg := BuildSystemMessage(agent.SystemPrompt, s.RawSummary)
		messages = append([]llm.ChatMessage{systemMsg}, messages...)

		steps = s.StepsCompleted
		totalUsage = s.TotalUsage
		toolFailures = s.ToolFailures
		if toolFailures == nil {
			toolFailures = make(map[string]int)
		}
		newMessages = make([]llm.ChatMessage, 0)
		hasSnapshot = true

		if runCtx.Checkpoint.Meta.Phase == PhasePostModel {
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

		sink.Emit(StreamEvent{
			Type:    EventRunResumed,
			Step:    steps,
			Attempt: runCtx.Checkpoint.Meta.Attempt,
		})
	} else {
		systemMsg := BuildSystemMessage(agent.SystemPrompt, runCtx.Summary)
		messages = make([]llm.ChatMessage, 0)
		messages = append(messages, systemMsg)
		messages = append(messages, runCtx.History...)
		messages = append(messages, llm.ChatMessage{
			Role:    "user",
			Content: runCtx.Input,
		})

		newMessages = make([]llm.ChatMessage, 0)
		toolFailures = make(map[string]int)
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
					totalUsage, toolFailures, checkpointFailures, PhasePreModel, r.toolRegistry,
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

			resp, err := client.ChatCompletion(ctx, &llm.ChatRequest{
				Model:       agent.Model,
				Messages:    messages,
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
						totalUsage, toolFailures, checkpointFailures, PhaseStepCompleted, r.toolRegistry,
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
					Output:      output,
					NewMessages: newMessages,
					Steps:       steps,
					Usage:       totalUsage,
				}, nil
			}

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
					totalUsage, toolFailures, checkpointFailures, PhasePostModel, r.toolRegistry,
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

		for _, call := range toolCalls {
			logger.Info("executing tool", "tool", call.Name, "call_id", call.ID)

			var rawArgs json.RawMessage
			if json.Valid(call.Arguments) {
				rawArgs = call.Arguments
			} else {
				rawArgs = json.RawMessage(`"` + strings.ReplaceAll(string(call.Arguments), `"`, `\"`) + `"`)
			}

			sink.Emit(StreamEvent{
				Type: EventToolStarted,
				Tool: &ToolMeta{ID: call.ID, Name: call.Name, Args: rawArgs},
				Step: steps,
			})
			sink.Emit(StreamEvent{Type: EventStatusUpdated, Status: fmt.Sprintf("Using %s", call.Name), Step: steps})

			tool, err := r.toolRegistry.Get(call.Name)
			if err != nil {
				logger.Error("tool not found, aborting", "tool", call.Name)
				sink.Emit(StreamEvent{
					Type:  EventToolFailed,
					Tool:  &ToolMeta{ID: call.ID, Name: call.Name, Args: rawArgs},
					Error: &ErrMeta{Code: "tool.not_found", Message: err.Error()},
					Step:  steps,
				})
				return nil, fmt.Errorf("%w: %s", ErrToolNotAvailable, call.Name)
			}

			start := time.Now()

			if ctx.Err() != nil {
				state = stateCancelled
				return nil, ctx.Err()
			}

			toolCtx, toolCancel := context.WithTimeout(ctx, 30*time.Second)
			toolCtx = runtimectx.WithMemoryScope(toolCtx, runCtx.Memory)
			toolResult, err := tool.Execute(toolCtx, tools.ToolCall{
				ID:   call.ID,
				Args: call.Arguments,
			})
			toolCancel()

			latencyMs := time.Since(start).Milliseconds()

			if err != nil {
				toolFailures[call.Name]++
				if toolFailures[call.Name] >= 3 {
					state = stateFailed
					return nil, fmt.Errorf("tool %q exceeded failure threshold: %v", call.Name, err)
				}

				errMsg := llm.ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Content:    fmt.Sprintf("[error] tool %q failed: %s", call.Name, err.Error()),
					Metadata: map[string]any{
						"tool_name":  call.Name,
						"arguments":  string(call.Arguments),
						"is_error":   true,
						"latency_ms": latencyMs,
					},
				}
				messages = append(messages, errMsg)
				newMessages = append(newMessages, errMsg)
				logger.Error("tool execution failed", "tool", call.Name, "error", err)

				sink.Emit(StreamEvent{
					Type:       EventToolFailed,
					Step:       steps,
					Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: rawArgs},
					Error:      &ErrMeta{Code: "tool.execution_failed", Message: err.Error()},
					DurationMs: latencyMs,
				})
				continue
			}

			if len(toolResult.Content) > 8000 {
				r := []rune(toolResult.Content)
				if len(r) > 8000 {
					toolResult.Content = string(r[:8000]) + "\n\n...(truncated due to length limit)"
				}
			}

			logger.Info("tool completed",
				"tool", call.Name,
				"is_error", toolResult.IsError,
				"content_len", len(toolResult.Content),
				"latency_ms", latencyMs)

			toolMsg := llm.ChatMessage{
				Role:       "tool",
				ToolCallID: call.ID,
				Content:    toolResult.Content,
				Metadata: map[string]any{
					"tool_name":  call.Name,
					"arguments":  string(call.Arguments),
					"is_error":   toolResult.IsError,
					"latency_ms": latencyMs,
				},
			}
			messages = append(messages, toolMsg)
			newMessages = append(newMessages, toolMsg)

			displayStr := fmt.Sprintf("Finished %s", call.Name)
			if toolResult.Content != "" && len(toolResult.Content) < 50 {
				displayStr = fmt.Sprintf("Result: %s", toolResult.Content)
			}
			if toolResult.IsError {
				displayStr = fmt.Sprintf("Error in %s", call.Name)
			}

			sink.Emit(StreamEvent{
				Type:       EventToolCompleted,
				Step:       steps,
				Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: rawArgs, Display: displayStr},
				DurationMs: latencyMs,
			})
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

func (r *AgentRuntime) loadTools(agent *Agent) ([]llm.ToolDefinition, error) {
	if len(agent.Tools) == 0 {
		return []llm.ToolDefinition{}, nil
	}

	defs := make([]llm.ToolDefinition, 0, len(agent.Tools))
	for _, name := range agent.Tools {
		tool, err := r.toolRegistry.Get(name)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrToolNotAvailable, name)
		}
		defs = append(defs, tool.Definition())
	}
	return defs, nil
}

func buildSnapshot(
	runCtx RunContext, ag *Agent, messages []llm.ChatMessage, summary string,
	steps, maxSteps int, usage llm.TokenUsage, toolFailures map[string]int,
	checkpointFailures int, phase string, registry *tools.ToolRegistry,
) RunSnapshot {

	toolsUsed := ag.Tools
	if toolsUsed == nil {
		toolsUsed = []string{}
	}

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
		},
		Meta: SnapshotMeta{
			AgentID:            ag.ID,
			ThreadID:           runCtx.ThreadID,
			Provider:           ag.Provider,
			Model:              ag.Model,
			Temperature:        ag.Temperature,
			ToolsetVersion:     ComputeToolsetVersion(registry),
			ToolsUsed:          toolsUsed,
			Attempt:            runCtx.Attempt,
			Phase:              phase,
			CheckpointFailures: checkpointFailures,
			LastCheckpointAt:   time.Now(),
			CreatedAt:          time.Now(),
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
