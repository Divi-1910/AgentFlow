package agent

import (
	"context"
	"fmt"
	"log"
	"strings"

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

	resp, err := client.ChatCompletion(ctx, &llm.ChatRequest{
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
		Temperature: 0, // deterministic summaries — same input must produce same output
		MaxTokens:   1024,
	})
	if err != nil {
		log.Printf("[summarizer] ✗ failed: %v", err)
		return "", llm.TokenUsage{}, err
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
		if len(snippet) > maxToolContentLen {
			snippet = snippet[:maxToolContentLen] + "... [truncated]"
		}
		return fmt.Sprintf("tool result: %s\n", snippet)

	default:
		return ""
	}
}
