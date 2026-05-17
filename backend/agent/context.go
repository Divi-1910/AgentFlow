package agent

import (
	"math"

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
	const tokensPerMessage = 4
	for _, m := range messages {
		total += tokensPerMessage
		total += len([]rune(m.Content)) / tokensPerMessage
		for _, tc := range m.ToolCalls {
			total += len([]rune(tc.Name)) / tokensPerMessage
			total += len((tc.Arguments)) / tokensPerMessage
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

// estimatedStaticSystemOverheadChars is the FALLBACK reserve used by
// ShouldSummarize when the caller does not have access to a ContextBuilder.
// It is intentionally conservative: better to summarize a turn early than
// to overflow the model's context. Callers that do have a builder should
// prefer ShouldSummarizeWithSysTokens with the builder's accurate estimate.
const estimatedStaticSystemOverheadChars = 12000 // ~3000 tokens

// ShouldSummarize is the heuristic fallback for summarization triggering:
// it uses a fixed conservative reserve for the layered system message
// because it has no access to the runtime's ContextBuilder.
//
// In the control path the message handler calls ShouldSummarizeWithSysTokens
// with a builder-derived estimate. This function remains for callers that
// cannot reach the runtime.
func ShouldSummarize(a *Agent, summary string, turns []Turn) bool {
	sysTokens := (len(a.SystemPrompt) + len(summary) + estimatedStaticSystemOverheadChars) / 4
	return ShouldSummarizeWithSysTokens(a, sysTokens, turns)
}

// ShouldSummarizeWithSysTokens returns true when the run is approaching the
// model's context window. sysTokens is the caller's best estimate of the
// system message size in tokens (typically from
// ContextBuilder.EstimateSystemPromptTokens). This avoids the fixed-overhead
// approximation in ShouldSummarize and is the accurate input to compaction.
func ShouldSummarizeWithSysTokens(a *Agent, sysTokens int, turns []Turn) bool {
	modelLimit := resolveContextLimit(a)
	threshold := int(math.Ceil(float64(modelLimit) * contextTriggerRatio))
	historyTokens := estimateTokens(FlattenTurns(turns))
	return sysTokens+historyTokens >= threshold
}

// SplitTurnsForCompaction is the heuristic fallback used when the caller
// does not have a sys-token estimate. It approximates the static system
// overhead by subtracting only the summary tokens from the keep budget.
//
// In the control path, prefer SplitTurnsForCompactionWithSysTokens so the
// keep budget reflects the full assembled system message — that is the
// only way to drop turns when the prompt is heavy on platform/tool/memory
// content and the history is otherwise modest.
func SplitTurnsForCompaction(a *Agent, summary string, turns []Turn) (drop, keep []Turn) {
	sysTokens := len(summary)/4 + estimatedStaticSystemOverheadChars/4
	return SplitTurnsForCompactionWithSysTokens(a, sysTokens, turns)
}

// SplitTurnsForCompactionWithSysTokens selects which turns to keep so that
// the rendered system message plus the kept history fits inside the
// configured keep budget. sysTokens is the builder-derived estimate of the
// full system message (platform + agent + tool_instructions +
// user_preferences + context).
//
// The function preserves the minimum-turns floor (a.ContextWindow) — turns
// inside that floor are never dropped even if the budget is exceeded, so
// the model always sees recent context. It is the caller's responsibility
// to handle hard overflow above the floor.
func SplitTurnsForCompactionWithSysTokens(a *Agent, sysTokens int, turns []Turn) (drop, keep []Turn) {
	if len(turns) == 0 {
		return nil, turns
	}

	modelLimit := resolveContextLimit(a)

	keepRatio := a.ContextKeepRatio
	if keepRatio == 0 {
		keepRatio = DefaultContextKeepRatio
	}
	keepBudget := int(float64(modelLimit) * keepRatio)
	keepBudget -= sysTokens
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
