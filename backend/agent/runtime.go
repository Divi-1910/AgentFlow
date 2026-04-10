package agent

import (
	"context"
	"fmt"
	"log"
	"strings"

	"backend/llm"
	"backend/tools"
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

func (r *AgentRuntime) Run(ctx context.Context, agent *Agent, input string) (*RunResult, error) {
	maxSteps := agent.MaxSteps
	if maxSteps == 0 {
		maxSteps = defaultMaxSteps
	}

	client, err := r.llmRegistry.Get(agent.Provider)
	if err != nil {
		return nil, fmt.Errorf("runtime: %w", err)
	}

	toolDefs, err := r.loadTools(agent)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrToolNotAvailable, err.Error())
	}

	messages := make([]llm.ChatMessage, 0, 8)

	if agent.SystemPrompt != "" {
		messages = append(messages, llm.ChatMessage{
			Role:    "system",
			Content: agent.SystemPrompt,
		})
	}

	messages = append(messages, llm.ChatMessage{
		Role:    "user",
		Content: input,
	})

	var totalUsage llm.TokenUsage
	steps := 0

	for steps < maxSteps {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

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
			return nil, fmt.Errorf("runtime: llm call failed at step %d: %w", steps+1, err)
		}

		steps++

		totalUsage.PromptTokens += resp.Usage.PromptTokens
		totalUsage.CompletionTokens += resp.Usage.CompletionTokens
		totalUsage.TotalTokens += resp.Usage.TotalTokens

		if len(resp.ToolCalls) == 0 {
			output := strings.TrimSpace(resp.Content)

			if output == "" {
				return nil, ErrNoFinalOutput
			}

			messages = append(messages, llm.ChatMessage{
				Role:    "assistant",
				Content: resp.Content,
			})

			log.Printf("[runtime] done steps=%d prompt_tokens=%d completion_tokens=%d",
				steps, totalUsage.PromptTokens, totalUsage.CompletionTokens)

			return &RunResult{
				Output:   output,
				Messages: messages,
				Steps:    steps,
				Usage:    totalUsage,
			}, nil
		}

		log.Printf("[runtime] step=%d tool_calls=%d", steps, len(resp.ToolCalls))

		messages = append(messages, llm.ChatMessage{
			Role:      "assistant",
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		for _, call := range resp.ToolCalls {
			log.Printf("[runtime] executing tool=%s id=%s", call.Name, call.ID)

			tool, err := r.toolRegistry.Get(call.Name)
			if err != nil {
				messages = append(messages, llm.ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Content:    fmt.Sprintf("[error] tool %q not available", call.Name),
				})
				log.Printf("[runtime] ✗ tool not found: %s", call.Name)
				continue
			}

			result, err := tool.Execute(ctx, call.Arguments)
			if err != nil {
				messages = append(messages, llm.ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Content:    fmt.Sprintf("[error] tool %q failed: %s", call.Name, err.Error()),
				})
				log.Printf("[runtime] ✗ tool execution failed: %s err=%v", call.Name, err)
				continue
			}

			log.Printf("[runtime] ✓ tool=%s is_error=%v content_len=%d",
				call.Name, result.IsError, len(result.Content))

			messages = append(messages, llm.ChatMessage{
				Role:       "tool",
				ToolCallID: call.ID,
				Content:    result.Content,
			})
		}
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
			return nil, fmt.Errorf("tool %q not registered", name)
		}
		defs = append(defs, tool.Definition())
	}

	return defs, nil
}
