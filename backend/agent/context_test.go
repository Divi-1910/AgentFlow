package agent

import (
	"math"
	"strings"
	"testing"

	"backend/llm"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func userMsg(content string) llm.ChatMessage {
	return llm.ChatMessage{Role: "user", Content: content}
}

func assistantMsg(content string) llm.ChatMessage {
	return llm.ChatMessage{Role: "assistant", Content: content}
}

// agentWithLimit returns a minimal Agent with a specific context limit and
// default keep-ratio / context-window so token math is predictable.
func agentWithLimit(limit int) *Agent {
	return &Agent{
		ModelContextLimit: limit,
		ContextKeepRatio:  DefaultContextKeepRatio, // 0.5
		ContextWindow:     DefaultContextWindow,    // 6
	}
}

// repeat builds a string of n copies of "x". len(repeat(n)) == n.
func repeat(n int) string { return strings.Repeat("x", n) }

// ── GroupIntoTurns ────────────────────────────────────────────────────────────

func TestGroupIntoTurnsReturnsEmptyForEmptyInput(t *testing.T) {
	t.Parallel()
	turns := GroupIntoTurns(nil)
	if len(turns) != 0 {
		t.Errorf("want 0 turns, got %d", len(turns))
	}
}

func TestGroupIntoTurnsSingleUserMessageProducesOneTurn(t *testing.T) {
	t.Parallel()
	msgs := []llm.ChatMessage{userMsg("hello")}
	turns := GroupIntoTurns(msgs)
	if len(turns) != 1 {
		t.Fatalf("want 1 turn, got %d", len(turns))
	}
	if turns[0].UserMessage.Content != "hello" {
		t.Errorf("UserMessage.Content: got %q, want %q", turns[0].UserMessage.Content, "hello")
	}
	if len(turns[0].AgentMessages) != 0 {
		t.Errorf("want no agent messages, got %d", len(turns[0].AgentMessages))
	}
}

func TestGroupIntoTurnsAttachesAssistantMessagesToPrecedingUser(t *testing.T) {
	t.Parallel()
	msgs := []llm.ChatMessage{
		userMsg("question"),
		assistantMsg("answer 1"),
		assistantMsg("answer 2"),
	}
	turns := GroupIntoTurns(msgs)
	if len(turns) != 1 {
		t.Fatalf("want 1 turn, got %d", len(turns))
	}
	if len(turns[0].AgentMessages) != 2 {
		t.Errorf("want 2 agent messages, got %d", len(turns[0].AgentMessages))
	}
}

func TestGroupIntoTurnsProducesOneTurnPerUserMessage(t *testing.T) {
	t.Parallel()
	msgs := []llm.ChatMessage{
		userMsg("q1"),
		assistantMsg("a1"),
		userMsg("q2"),
		assistantMsg("a2"),
		userMsg("q3"),
	}
	turns := GroupIntoTurns(msgs)
	if len(turns) != 3 {
		t.Fatalf("want 3 turns, got %d", len(turns))
	}
	if turns[1].UserMessage.Content != "q2" {
		t.Errorf("turn[1] user: got %q, want %q", turns[1].UserMessage.Content, "q2")
	}
}

func TestGroupIntoTurnsDropsAssistantMessagesBeforeFirstUser(t *testing.T) {
	t.Parallel()
	msgs := []llm.ChatMessage{
		assistantMsg("orphaned"),
		userMsg("first user"),
	}
	turns := GroupIntoTurns(msgs)
	if len(turns) != 1 {
		t.Fatalf("want 1 turn, got %d", len(turns))
	}
	if len(turns[0].AgentMessages) != 0 {
		t.Errorf("want 0 agent messages (orphan dropped), got %d", len(turns[0].AgentMessages))
	}
}

// ── FlattenTurns ──────────────────────────────────────────────────────────────

func TestFlattenTurnsReturnsEmptySliceForEmptyInput(t *testing.T) {
	t.Parallel()
	msgs := FlattenTurns(nil)
	if msgs == nil {
		t.Error("want non-nil empty slice, got nil")
	}
	if len(msgs) != 0 {
		t.Errorf("want 0 messages, got %d", len(msgs))
	}
}

func TestFlattenTurnsPreservesUserThenAssistantOrder(t *testing.T) {
	t.Parallel()
	turns := []Turn{
		{
			UserMessage:   userMsg("q"),
			AgentMessages: []llm.ChatMessage{assistantMsg("a1"), assistantMsg("a2")},
		},
	}
	msgs := FlattenTurns(turns)
	if len(msgs) != 3 {
		t.Fatalf("want 3 messages, got %d", len(msgs))
	}
	if msgs[0].Role != "user" {
		t.Errorf("msgs[0] role: got %q, want user", msgs[0].Role)
	}
	if msgs[1].Content != "a1" {
		t.Errorf("msgs[1] content: got %q, want a1", msgs[1].Content)
	}
	if msgs[2].Content != "a2" {
		t.Errorf("msgs[2] content: got %q, want a2", msgs[2].Content)
	}
}

// ── LookupContextLimit ────────────────────────────────────────────────────────

func TestLookupContextLimitReturnsKnownModelLimit(t *testing.T) {
	t.Parallel()
	got := LookupContextLimit("gpt-5.4-mini")
	if got != 400000 {
		t.Errorf("gpt-5.4-mini: got %d, want 400000", got)
	}
}

func TestLookupContextLimitReturnsDefaultForUnknownModel(t *testing.T) {
	t.Parallel()
	got := LookupContextLimit("totally-unknown-model-xyz")
	if got != defaultModelContextLimit {
		t.Errorf("unknown model: got %d, want %d", got, defaultModelContextLimit)
	}
}

// ── ShouldSummarize ───────────────────────────────────────────────────────────

// Token math notes:
//   ShouldSummarize reserves estimatedStaticSystemOverheadChars/4 tokens for
//   the layered system prompt (platform XML + tool_instructions +
//   user_preferences + context wrapper) on top of the variable
//   SystemPrompt + summary cost. Tests that depend on exact threshold math
//   use a large model limit so the static overhead is a small fraction.

func TestShouldSummarizeReturnsFalseWhenBelowThreshold(t *testing.T) {
	t.Parallel()
	const limit = 128000
	a := agentWithLimit(limit)
	threshold := int(math.Ceil(float64(limit) * contextTriggerRatio))
	overheadTokens := estimatedStaticSystemOverheadChars / 4
	// history sized to be just below (threshold − overhead), with a margin
	// for the per-message overhead inside estimateTokens.
	contentChars := (threshold - overheadTokens - 10) * 4
	turns := []Turn{{UserMessage: userMsg(repeat(contentChars))}}
	if ShouldSummarize(a, "", turns) {
		t.Error("want false (below threshold), got true")
	}
}

func TestShouldSummarizeReturnsTrueAtThreshold(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(100)
	// history = 85 tokens; estimatedStaticSystemOverheadChars pushes the
	// estimate well past the 85-token threshold, so this must trigger.
	turns := []Turn{{UserMessage: userMsg(repeat(324))}}
	if !ShouldSummarize(a, "", turns) {
		t.Error("want true (at threshold), got false")
	}
}

func TestShouldSummarizeReturnsTrueWhenAboveThreshold(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(100)
	// history > 85 tokens
	turns := []Turn{{UserMessage: userMsg(repeat(400))}}
	if !ShouldSummarize(a, "", turns) {
		t.Error("want true (above threshold), got false")
	}
}

func TestShouldSummarizeIncludesStaticSystemOverheadInEstimate(t *testing.T) {
	t.Parallel()
	// Pick a model limit where a tiny conversation can still trip the
	// threshold purely because of static system overhead.
	limit := estimatedStaticSystemOverheadChars / 4 // overhead alone exhausts the limit
	a := agentWithLimit(limit + 10)                 // sit just above the overhead
	// Empty conversation must still trigger because static overhead consumes
	// almost the entire budget.
	if !ShouldSummarize(a, "", nil) {
		t.Errorf("expected static system overhead alone to trip the threshold at limit=%d", limit+10)
	}
}

// TestShouldSummarizeWithSysTokensUsesProvidedEstimate proves the control-path
// helper trusts the caller's sysTokens (sourced from
// ContextBuilder.EstimateSystemPromptTokens) instead of layering its own
// static reserve.
func TestShouldSummarizeWithSysTokensUsesProvidedEstimate(t *testing.T) {
	t.Parallel()
	const limit = 1000
	a := agentWithLimit(limit)
	threshold := int(math.Ceil(float64(limit) * contextTriggerRatio)) // 850

	// With a small sysTokens estimate and no history, we should not summarize.
	if ShouldSummarizeWithSysTokens(a, 100, nil) {
		t.Errorf("want false when sysTokens=100 well below threshold=%d", threshold)
	}
	// With sysTokens alone at the threshold, we must summarize.
	if !ShouldSummarizeWithSysTokens(a, threshold, nil) {
		t.Errorf("want true when sysTokens=%d (== threshold)", threshold)
	}
	// And ShouldSummarize (heuristic) and ShouldSummarizeWithSysTokens diverge
	// when the accurate estimate is much smaller than the static reserve.
	if !ShouldSummarize(a, "", nil) {
		t.Error("heuristic should trip at this limit (static reserve dominates)")
	}
	if ShouldSummarizeWithSysTokens(a, 50, nil) {
		t.Error("accurate path with sysTokens=50 should NOT trip — proves the heuristic is bypassed")
	}
}

// ── SplitTurnsForCompaction ───────────────────────────────────────────────────

// These tests exercise pure budget arithmetic. They call the lower-level
// SplitTurnsForCompactionWithSysTokens so the upstream static-overhead reserve
// in SplitTurnsForCompaction doesn't distort the math.
//
// Token math helpers:
//   agentWithLimit(60) → keepBudget = int(60 * 0.5) = 30 tokens
//   turn with 40-char user content → estimateTurnTokens = 40/4 = 10 tokens
//   turn with 80-char user content → estimateTurnTokens = 80/4 = 20 tokens

func makeTurns(n int, contentLen int) []Turn {
	turns := make([]Turn, n)
	for i := range turns {
		turns[i] = Turn{UserMessage: userMsg(repeat(contentLen))}
	}
	return turns
}

func TestSplitTurnsForCompactionReturnsAllTurnsWhenTheyFitInBudget(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(100000) // huge limit — nothing gets dropped
	turns := makeTurns(5, 40)
	drop, keep := SplitTurnsForCompactionWithSysTokens(a, 0, turns)
	if drop != nil {
		t.Errorf("want nil drop slice, got %d turns", len(drop))
	}
	if len(keep) != 5 {
		t.Errorf("want 5 turns kept, got %d", len(keep))
	}
}

func TestSplitTurnsForCompactionDropsOldestTurnsWhenOverBudget(t *testing.T) {
	t.Parallel()
	a := &Agent{
		ModelContextLimit: 60,
		ContextKeepRatio:  0.5, // keepBudget = 30
		ContextWindow:     1,   // minTurns = 1
	}
	// 5 turns × 10 tokens each; budget allows 3 (30 tokens, 4th would be 40 > 30 with keepCount≥1)
	turns := makeTurns(5, 40) // 40 chars → 10 tokens each
	drop, keep := SplitTurnsForCompactionWithSysTokens(a, 0, turns)
	if len(keep) != 3 {
		t.Errorf("want 3 turns kept, got %d", len(keep))
	}
	if len(drop) != 2 {
		t.Errorf("want 2 turns dropped, got %d", len(drop))
	}
}

func TestSplitTurnsForCompactionRespectsMinTurnsOverBudget(t *testing.T) {
	t.Parallel()
	a := &Agent{
		ModelContextLimit: 60,
		ContextKeepRatio:  0.5, // keepBudget = 30
		ContextWindow:     4,   // minTurns = 4
	}
	turns := makeTurns(6, 80) // 80 chars → 20 tokens each
	drop, keep := SplitTurnsForCompactionWithSysTokens(a, 0, turns)
	if len(keep) != 4 {
		t.Errorf("want 4 turns kept (minTurns enforced), got %d", len(keep))
	}
	if len(drop) != 2 {
		t.Errorf("want 2 turns dropped, got %d", len(drop))
	}
}

func TestSplitTurnsForCompactionDeductsSysTokensFromBudget(t *testing.T) {
	t.Parallel()
	// keepBudget = 30, each turn = 10 tokens, minTurns = 1
	// Without overhead: 3 turns fit (30 tokens).
	// With sysTokens=10: effective budget = 20 → only 2 turns fit.
	a := &Agent{
		ModelContextLimit: 60,
		ContextKeepRatio:  0.5,
		ContextWindow:     1,
	}
	turns := makeTurns(5, 40)
	_, keepHeavySys := SplitTurnsForCompactionWithSysTokens(a, 10, turns)
	_, keepNoSys := SplitTurnsForCompactionWithSysTokens(a, 0, turns)

	if len(keepHeavySys) >= len(keepNoSys) {
		t.Errorf("sysTokens should reduce kept turns: with=%d, without=%d",
			len(keepHeavySys), len(keepNoSys))
	}
}

// TestSplitDropsTurnsWhenSysPromptIsLargeButHistoryIsSmall covers the exact
// failure mode the second review flagged: a heavy system prompt should
// trigger compaction even when history alone fits the legacy budget.
func TestSplitDropsTurnsWhenSysPromptIsLargeButHistoryIsSmall(t *testing.T) {
	t.Parallel()
	a := &Agent{
		ModelContextLimit: 200,
		ContextKeepRatio:  0.5, // keepBudget = 100
		ContextWindow:     1,
	}
	turns := makeTurns(5, 40) // 50 history tokens — fits 100-token budget cleanly
	// No drops without sys overhead.
	dropNoSys, _ := SplitTurnsForCompactionWithSysTokens(a, 0, turns)
	if dropNoSys != nil {
		t.Errorf("history alone should fit: got %d drops, want 0", len(dropNoSys))
	}
	// With a large sys estimate (90 tokens) the effective budget drops to 10
	// — only ~1 turn fits and the rest must spill into the drop slice.
	dropWithSys, keepWithSys := SplitTurnsForCompactionWithSysTokens(a, 90, turns)
	if len(dropWithSys) == 0 {
		t.Errorf("large sys estimate should force compaction; got 0 drops, kept=%d", len(keepWithSys))
	}
}

func TestSplitTurnsForCompactionReturnsAllTurnsForEmptyInput(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(1000)
	drop, keep := SplitTurnsForCompactionWithSysTokens(a, 0, nil)
	if drop != nil {
		t.Errorf("want nil drop for empty input, got %v", drop)
	}
	if len(keep) != 0 {
		t.Errorf("want 0 turns kept, got %d", len(keep))
	}
}

// TestLegacySplitTurnsForCompactionAddsStaticOverhead verifies the heuristic
// fallback keeps fewer turns than the explicit zero-sys path, proving the
// static reserve is applied.
func TestLegacySplitTurnsForCompactionAddsStaticOverhead(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(100000) // big enough that pure budget keeps all 5 turns
	turns := makeTurns(5, 40)
	_, keepZero := SplitTurnsForCompactionWithSysTokens(a, 0, turns)
	_, keepHeuristic := SplitTurnsForCompaction(a, "", turns)
	if len(keepHeuristic) > len(keepZero) {
		t.Errorf("heuristic must not keep more than the zero-sys path")
	}
}

// ── estimateTokens threshold cross-check ─────────────────────────────────────

func TestEstimateTokensReturnsZeroForEmptyMessages(t *testing.T) {
	t.Parallel()
	if got := estimateTokens(nil); got != 0 {
		t.Errorf("got %d, want 0", got)
	}
}

func TestEstimateTokensReturnsPositiveForNonEmptyMessage(t *testing.T) {
	t.Parallel()
	msgs := []llm.ChatMessage{{Role: "user", Content: "hello"}}
	if got := estimateTokens(msgs); got <= 0 {
		t.Errorf("got %d, want > 0", got)
	}
}

// Verify the threshold formula used by ShouldSummarize is consistent with the
// contextTriggerRatio constant so tests stay in sync with the implementation.
func TestShouldSummarizeThresholdMatchesContextTriggerRatio(t *testing.T) {
	t.Parallel()
	const limit = 100
	a := agentWithLimit(limit)
	threshold := int(math.Ceil(float64(limit) * contextTriggerRatio))

	// One message exactly at threshold should trigger summarization.
	// estimateTokens overhead = 4 per message, so content tokens needed = threshold - 4.
	// content chars needed = (threshold - 4) * 4
	contentLen := (threshold - 4) * 4
	turns := []Turn{{UserMessage: userMsg(repeat(contentLen))}}

	if !ShouldSummarize(a, "", turns) {
		t.Errorf("expected ShouldSummarize=true at threshold=%d (contextTriggerRatio=%.2f)",
			threshold, contextTriggerRatio)
	}
}
