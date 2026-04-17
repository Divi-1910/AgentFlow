package agent

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"backend/llm"
)

type Summarizer struct {
	llmRegistry *llm.LLMRegistry
}

func NewSummarizer(llmRegistry *llm.LLMRegistry) *Summarizer {
	return &Summarizer{llmRegistry: llmRegistry}
}

func (s *Summarizer) Summarize(
	ctx context.Context,
	agent *Agent,
	previousSummary string,
	droppedTurns []Turn,
) (string, llm.TokenUsage, error) {
	model := agent.SummarizationModel
	if model == "" {
		model = agent.Model
	}

	client, err := s.llmRegistry.Get(agent.Provider)
	if err != nil {
		return "", llm.TokenUsage{}, fmt.Errorf("summarizer: provider %q unavailable: %w", agent.Provider, err)
	}

	input := s.buildSummarizationInput(previousSummary, droppedTurns)

	req := &llm.ChatRequest{
		Model: model,
		Messages: []llm.ChatMessage{
			{
				Role: "user",
				Content: fmt.Sprintf(`Summarize the following conversation.
Preserve: names, preferences, key facts, decisions, conclusions.
Discard: filler, raw tool outputs, intermediate reasoning steps.
Be concise. Max 300 words.

%s

Return only the updated summary.`, input),
			},
		},
		Temperature: 0,
		MaxTokens:   2048,
	}

	const maxAttempts = 3
	var (
		resp    *llm.ChatResponse
		callErr error
	)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		resp, callErr = client.ChatCompletion(ctx, req)
		if callErr == nil {
			break
		}
		if attempt < maxAttempts {
			backoff := time.Duration(attempt*attempt) * time.Second
			log.Printf("[summarizer] attempt %d/%d failed, retrying in %s: %v", attempt, maxAttempts, backoff, callErr)
			select {
			case <-ctx.Done():
				return "", llm.TokenUsage{}, ctx.Err()
			case <-time.After(backoff):
			}
		}
	}
	if callErr != nil {
		log.Printf("[summarizer] ✗ all %d attempts failed: %v", maxAttempts, callErr)
		return "", llm.TokenUsage{}, callErr
	}

	summary := strings.TrimSpace(resp.Content)
	log.Printf("[summarizer] ✓ produced summary len=%d tokens=%d", len(summary), resp.Usage.TotalTokens)
	return summary, resp.Usage, nil
}

func (s *Summarizer) buildSummarizationInput(previousSummary string, turns []Turn) string {
	var sb strings.Builder

	if strings.TrimSpace(previousSummary) != "" {
		sb.WriteString("Previous summary:\n")
		sb.WriteString(previousSummary)
		sb.WriteString("\n\n")
	}

	sb.WriteString("Conversation to summarize:\n")

	for _, t := range turns {
		sb.WriteString(fmt.Sprintf("user: %s\n", strings.TrimSpace(t.UserMessage.Content)))
		for _, m := range t.AgentMessages {
			sb.WriteString(s.preprocessMessage(m))
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

func (s *Summarizer) preprocessMessage(m llm.ChatMessage) string {
	const maxToolContentLen = 200

	switch m.Role {
	case "assistant":
		if len(m.ToolCalls) > 0 {
			names := make([]string, len(m.ToolCalls))
			for i, tc := range m.ToolCalls {
				names[i] = tc.Name
			}
			return fmt.Sprintf("assistant called tool(s): %s\n", strings.Join(names, ", "))
		}
		if content := strings.TrimSpace(m.Content); content != "" {
			return fmt.Sprintf("assistant: %s\n", content)
		}
		return ""

	case "tool":
		snippet := m.Content
		if len([]rune(snippet)) > maxToolContentLen {
			snippet = string([]rune(m.Content)[:maxToolContentLen]) + "... [truncated]"
		}
		return fmt.Sprintf("tool result: %s\n", snippet)

	default:
		return ""
	}
}
