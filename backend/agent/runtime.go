package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"runtime/debug"
	"strings"
	"time"

	"backend/llm"
	"backend/tools"

	"github.com/google/uuid"
)

type AgentRuntime struct {
	llmRegistry  *llm.LLMRegistry
	toolRegistry *tools.ToolRegistry
}

func NewAgentRuntime(llmRegistry *llm.LLMRegistry, toolRegistry *tools.ToolRegistry) *AgentRuntime {
	return &AgentRuntime{
		llmRegistry:  llmRegistry,
		toolRegistry: toolRegistry,
	}
}

func (r *AgentRuntime) Run(ctx context.Context, agent *Agent, runCtx RunContext) (*RunResult, error) {
	return r.runInternal(ctx, agent, runCtx, &NoopSink{})
}

func (r *AgentRuntime) RunStream(ctx context.Context, agent *Agent, runCtx RunContext, events chan<- StreamEvent) (*RunResult, error) {
	runID := uuid.NewString()
	sink := NewChannelSink(ctx, runID, events)
	return r.runInternal(ctx, agent, runCtx, sink)
}

type terminalState int

const (
	stateFailed terminalState = iota
	stateSuccess
	stateCancelled
)

func (r *AgentRuntime) runInternal(ctx context.Context, agent *Agent, runCtx RunContext, sink EventSink) (result *RunResult, err error) {
	state := stateFailed
	runStart := time.Now()

	sink.Emit(StreamEvent{
		Type:     EventRunStarted,
		Provider: agent.Provider,
		Model:    agent.Model,
	})

	defer func() {
		var panicStackTrace string
		if rec := recover(); rec != nil {
			panicStackTrace = string(debug.Stack())
			log.Printf("[runtime] PANIC RECOVERED: %v\n%s", rec, panicStackTrace)
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
			errCode := "engine.runtime_error"
			if err != nil {
				errMsg = err.Error()
				if strings.Contains(errMsg, "max steps") {
					errCode = "engine.max_steps"
				} else if strings.Contains(errMsg, "panic") {
					errCode = "engine.panic"
				} else if strings.Contains(errMsg, "not found in registry") {
					errCode = "tool.not_found"
				} else if strings.Contains(errMsg, "llm registry") {
					errCode = "provider.unavailable"
				}
			}
			sink.Emit(StreamEvent{
				Type:       EventRunFailed,
				DurationMs: duration,
				Error:      &ErrMeta{Code: errCode, Message: errMsg},
			})
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

	systemMsg := BuildSystemMessage(agent.SystemPrompt, runCtx.Summary)

	messages := make([]llm.ChatMessage, 0, 1+len(runCtx.History)+1+8)
	messages = append(messages, systemMsg)
	messages = append(messages, runCtx.History...)
	messages = append(messages, llm.ChatMessage{
		Role:    "user",
		Content: runCtx.Input,
	})

	newMessages := make([]llm.ChatMessage, 0, 8)

	var totalUsage llm.TokenUsage
	steps := 0

	for steps < maxSteps {
		if ctx.Err() != nil {
			state = stateCancelled
			return nil, ctx.Err()
		}

		sink.Emit(StreamEvent{Type: EventStepStarted, Step: steps + 1, MaxSteps: maxSteps})
		sink.Emit(StreamEvent{Type: EventStatusUpdated, Status: "Calling model", Step: steps + 1})

		log.Printf("[runtime] step=%d agent=%s provider=%s model=%s messages=%d",
			steps+1, agent.Name, agent.Provider, agent.Model, len(messages))

		resp, err := client.ChatCompletion(ctx, &llm.ChatRequest{
			Model:       agent.Model,
			Messages:    messages,
			Tools:       toolDefs,
			Temperature: agent.Temperature,
			MaxTokens:   agent.MaxTokens,
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
				return nil, ErrNoFinalOutput
			}

			finalMsg := llm.ChatMessage{Role: "assistant", Content: resp.Content}
			messages = append(messages, finalMsg)
			newMessages = append(newMessages, finalMsg)

			log.Printf("[runtime] done steps=%d prompt_tokens=%d completion_tokens=%d",
				steps, totalUsage.PromptTokens, totalUsage.CompletionTokens)

			sink.Emit(StreamEvent{Type: EventStepCompleted, Step: steps})

			state = stateSuccess
			return &RunResult{
				Output:      output,
				NewMessages: newMessages,
				Steps:       steps,
				Usage:       totalUsage,
			}, nil
		}

		log.Printf("[runtime] step=%d tool_calls=%d", steps, len(resp.ToolCalls))

		assistantMsg := llm.ChatMessage{
			Role:      "assistant",
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		}
		messages = append(messages, assistantMsg)
		newMessages = append(newMessages, assistantMsg)

		for _, call := range resp.ToolCalls {
			log.Printf("[runtime] executing tool=%s id=%s", call.Name, call.ID)

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
				log.Printf("[runtime] ✗ tool not found: %s — aborting", call.Name)
				sink.Emit(StreamEvent{
					Type:  EventToolFailed,
					Tool:  &ToolMeta{ID: call.ID, Name: call.Name, Args: rawArgs},
					Error: &ErrMeta{Code: "tool.not_found", Message: err.Error()},
					Step:  steps,
				})
				return nil, fmt.Errorf("%w: %s", ErrToolNotAvailable, call.Name)
			}

			start := time.Now()

			toolCtx, toolCancel := context.WithTimeout(ctx, 30*time.Second)
			result, err := tool.Execute(toolCtx, call.Arguments)
			toolCancel()

			latencyMs := time.Since(start).Milliseconds()

			if len(result.Content) > 8000 {
				r := []rune(result.Content)
				if len(r) > 8000 {
					result.Content = string(r[:8000]) + "\n\n...(truncated due to length limit)"
				}
			}

			if err != nil {
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
				log.Printf("[runtime] ✗ tool execution failed: %s err=%v", call.Name, err)

				sink.Emit(StreamEvent{
					Type:       EventToolFailed,
					Step:       steps,
					Tool:       &ToolMeta{ID: call.ID, Name: call.Name, Args: rawArgs},
					Error:      &ErrMeta{Code: "tool.execution_failed", Message: err.Error()},
					DurationMs: latencyMs,
				})
				continue
			}

			log.Printf("[runtime] ✓ tool=%s is_error=%v content_len=%d latency_ms=%d",
				call.Name, result.IsError, len(result.Content), latencyMs)

			toolMsg := llm.ChatMessage{
				Role:       "tool",
				ToolCallID: call.ID,
				Content:    result.Content,
				Metadata: map[string]any{
					"tool_name":  call.Name,
					"arguments":  string(call.Arguments),
					"is_error":   result.IsError,
					"latency_ms": latencyMs,
				},
			}
			messages = append(messages, toolMsg)
			newMessages = append(newMessages, toolMsg)

			displayStr := fmt.Sprintf("Finished %s", call.Name)
			if result.Content != "" && len(result.Content) < 50 {
				displayStr = fmt.Sprintf("Result: %s", result.Content)
			}
			if result.IsError {
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

	log.Printf("[runtime] max steps reached agent=%s steps=%d", agent.Name, steps)
	return nil, ErrMaxStepsReached
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
