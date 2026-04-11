package agent

import (
	"fmt"
	"math"
	"strings"

	"backend/llm"
)

const defaultModelContextLimit = 16000

var modelContextRegistry = map[string]int{
	"gpt-5.4-mini":                 400000,
	"gpt-5-mini":                   400000,
	"gpt-5.4-nano":                 400000,
	"gpt-5.4":                      262144,
	"gpt-5-nano":                   400000,
	"claude-sonnet-4-5":            200000,
	"claude-haiku-4-5":             200000,
	"claude-sonnet-4-6":            1000000,
	"meta/llama-3.1-405b-instruct": 128000,
	"meta/llama-3.1-70b-instruct":  128000,
	"moonshotai/kimi-k2-5":         262144,
	"qwen/qwen3.5-397b-a17b":       262144,
	"z-ai/glm5":                    200000,
}

func LookupContextLimit(modelID string) int {
	if limit, ok := modelContextRegistry[modelID]; ok {
		return limit
	}
	return defaultModelContextLimit
}

func resolveContextLimit(a *Agent) int {
	if a.ModelContextLimit > 0 {
		return a.ModelContextLimit
	}
	return LookupContextLimit(a.Model)
}

func estimateTokens(messages []llm.ChatMessage) int {
	total := 0
	for _, m := range messages {
		total += len(m.Content) / 4
		for _, tc := range m.ToolCalls {
			total += len(tc.Name) / 4
			total += len(tc.Arguments) / 4
		}
	}
	return total
}

func estimateTurnTokens(t Turn) int {
	tokens := len(t.UserMessage.Content) / 4
	for _, tc := range t.UserMessage.ToolCalls {
		tokens += len(tc.Name) / 4
		tokens += len(tc.Arguments) / 4
	}
	for _, m := range t.AgentMessages {
		tokens += len(m.Content) / 4
		for _, tc := range m.ToolCalls {
			tokens += len(tc.Name) / 4
			tokens += len(tc.Arguments) / 4
		}
	}
	return tokens
}

type Turn struct {
	UserMessage   llm.ChatMessage
	AgentMessages []llm.ChatMessage
}

func GroupIntoTurns(messages []llm.ChatMessage) []Turn {
	var turns []Turn
	var current *Turn

	for _, m := range messages {
		if m.Role == "user" {
			if current != nil {
				turns = append(turns, *current)
			}
			current = &Turn{UserMessage: m}
		} else if current != nil {
			current.AgentMessages = append(current.AgentMessages, m)
		}
	}

	if current != nil {
		turns = append(turns, *current)
	}

	return turns
}

func FlattenTurns(turns []Turn) []llm.ChatMessage {
	msgs := make([]llm.ChatMessage, 0)
	for _, t := range turns {
		msgs = append(msgs, t.UserMessage)
		msgs = append(msgs, t.AgentMessages...)
	}
	return msgs
}

func BuildSystemMessage(systemPrompt, summary string) llm.ChatMessage {
	content := systemPrompt
	if strings.TrimSpace(summary) != "" {
		content = fmt.Sprintf("%s\n\n---\nConversation Summary:\n%s", systemPrompt, summary)
	}
	return llm.ChatMessage{Role: "system", Content: content}
}

func ShouldSummarize(a *Agent, summary string, turns []Turn) bool {
	modelLimit := resolveContextLimit(a)
	threshold := int(math.Ceil(float64(modelLimit) * contextTriggerRatio))

	sysMsg := BuildSystemMessage(a.SystemPrompt, summary)
	sysTokens := len(sysMsg.Content) / 4

	historyTokens := estimateTokens(FlattenTurns(turns))

	return sysTokens+historyTokens >= threshold
}

func SplitTurnsForCompaction(a *Agent, summary string, turns []Turn) (drop, keep []Turn) {
	if len(turns) == 0 {
		return nil, turns
	}

	modelLimit := resolveContextLimit(a)

	keepRatio := a.ContextKeepRatio
	if keepRatio == 0 {
		keepRatio = DefaultContextKeepRatio
	}
	keepBudget := int(float64(modelLimit) * keepRatio)

	summaryTokens := len(summary) / 4
	keepBudget -= summaryTokens
	if keepBudget < 0 {
		keepBudget = 0
	}

	minTurns := a.ContextWindow
	if minTurns == 0 {
		minTurns = DefaultContextWindow
	}

	keepCount := 0
	tokensAccum := 0

	for i := len(turns) - 1; i >= 0; i-- {
		turnTokens := estimateTurnTokens(turns[i])
		if tokensAccum+turnTokens > keepBudget && keepCount >= minTurns {
			break
		}
		tokensAccum += turnTokens
		keepCount++
	}

	if keepCount >= len(turns) {
		return nil, turns
	}

	splitIdx := len(turns) - keepCount
	return turns[:splitIdx], turns[splitIdx:]
}
