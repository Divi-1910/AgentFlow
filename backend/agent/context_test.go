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

// ── BuildSystemMessage ────────────────────────────────────────────────────────

func TestBuildSystemMessageReturnsPromptAloneWhenNoSummary(t *testing.T) {
	t.Parallel()
	msg := BuildSystemMessage("You are helpful.", "")
	if msg.Role != "system" {
		t.Errorf("role: got %q, want system", msg.Role)
	}
	if msg.Content != "You are helpful." {
		t.Errorf("content: got %q, want plain prompt", msg.Content)
	}
}

func TestBuildSystemMessageAppendsSummarySection(t *testing.T) {
	t.Parallel()
	msg := BuildSystemMessage("You are helpful.", "User likes brevity.")
	expected := "You are helpful.\n\n---\nConversation Summary:\nUser likes brevity."
	if msg.Content != expected {
		t.Errorf("content:\ngot:  %q\nwant: %q", msg.Content, expected)
	}
}

func TestBuildSystemMessageIgnoresWhitespaceOnlySummary(t *testing.T) {
	t.Parallel()
	msg := BuildSystemMessage("Prompt.", "   \n  ")
	if msg.Content != "Prompt." {
		t.Errorf("content: got %q, want plain prompt (whitespace-only summary ignored)", msg.Content)
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

// Token math (ModelContextLimit=100, contextTriggerRatio=0.85):
//   threshold = ceil(100 * 0.85) = 85
//   estimateTokens: 4 overhead per message + len(content)/4
//
// Message with 324-char content: 4 + 324/4 = 4 + 81 = 85 tokens → AT threshold → true
// Message with 320-char content: 4 + 320/4 = 4 + 80 = 84 tokens → below threshold  → false

func TestShouldSummarizeReturnsFalseWhenBelowThreshold(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(100)
	// history = 84 tokens (below threshold of 85)
	turns := []Turn{{UserMessage: userMsg(repeat(320))}}
	if ShouldSummarize(a, "", turns) {
		t.Error("want false (below threshold), got true")
	}
}

func TestShouldSummarizeReturnsTrueAtThreshold(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(100)
	// history = 85 tokens (at threshold, >= returns true)
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

// ── SplitTurnsForCompaction ───────────────────────────────────────────────────

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
	drop, keep := SplitTurnsForCompaction(a, "", turns)
	if drop != nil {
		t.Errorf("want nil drop slice, got %d turns", len(drop))
	}
	if len(keep) != 5 {
		t.Errorf("want 5 turns kept, got %d", len(keep))
	}
}

func TestSplitTurnsForCompactionDropsOldestTurnsWhenOverBudget(t *testing.T) {
	t.Parallel()
	// keepBudget = 30 tokens, each turn = 10 tokens, minTurns = 6
	// Counting backwards: turns 4,3,2 fit (30 tokens). turn 1 would make 40 > 30 AND keepCount=3 >= 6? NO.
	// So minTurns forces 6 turns kept regardless of budget.
	// Use minTurns=1 to test pure budget behaviour.
	a := &Agent{
		ModelContextLimit: 60,
		ContextKeepRatio:  0.5, // keepBudget = 30
		ContextWindow:     1,   // minTurns = 1
	}
	// 5 turns × 10 tokens each; budget allows 3 (30 tokens, 4th would be 40 > 30 with keepCount≥1)
	turns := makeTurns(5, 40) // 40 chars → 10 tokens each
	drop, keep := SplitTurnsForCompaction(a, "", turns)
	if len(keep) != 3 {
		t.Errorf("want 3 turns kept, got %d", len(keep))
	}
	if len(drop) != 2 {
		t.Errorf("want 2 turns dropped, got %d", len(drop))
	}
}

func TestSplitTurnsForCompactionRespectsMinTurnsOverBudget(t *testing.T) {
	t.Parallel()
	// keepBudget = 30 tokens, each turn = 20 tokens, minTurns = 4
	// Pure budget would keep 1 turn (20 ≤ 30, 40 > 30).
	// But minTurns=4 forces keeping 4 turns even though they overflow budget.
	a := &Agent{
		ModelContextLimit: 60,
		ContextKeepRatio:  0.5, // keepBudget = 30
		ContextWindow:     4,   // minTurns = 4
	}
	turns := makeTurns(6, 80) // 80 chars → 20 tokens each
	drop, keep := SplitTurnsForCompaction(a, "", turns)
	if len(keep) != 4 {
		t.Errorf("want 4 turns kept (minTurns enforced), got %d", len(keep))
	}
	if len(drop) != 2 {
		t.Errorf("want 2 turns dropped, got %d", len(drop))
	}
}

func TestSplitTurnsForCompactionDeductsSummaryTokensFromBudget(t *testing.T) {
	t.Parallel()
	// keepBudget = 30, each turn = 10 tokens, minTurns = 1
	// Without summary: 3 turns fit (30 tokens).
	// summary = 40 chars → 40/4 = 10 tokens deducted → effective budget = 20.
	// With reduced budget: only 2 turns fit.
	a := &Agent{
		ModelContextLimit: 60,
		ContextKeepRatio:  0.5,
		ContextWindow:     1,
	}
	turns := makeTurns(5, 40) // 10 tokens each
	summary := repeat(40)     // 10 summary tokens deducted
	_, keepWithSummary := SplitTurnsForCompaction(a, summary, turns)
	_, keepWithout := SplitTurnsForCompaction(a, "", turns)

	if len(keepWithSummary) >= len(keepWithout) {
		t.Errorf("summary should reduce kept turns: with summary=%d, without=%d",
			len(keepWithSummary), len(keepWithout))
	}
}

func TestSplitTurnsForCompactionReturnsAllTurnsForEmptyInput(t *testing.T) {
	t.Parallel()
	a := agentWithLimit(1000)
	drop, keep := SplitTurnsForCompaction(a, "", nil)
	if drop != nil {
		t.Errorf("want nil drop for empty input, got %v", drop)
	}
	if len(keep) != 0 {
		t.Errorf("want 0 turns kept, got %d", len(keep))
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
