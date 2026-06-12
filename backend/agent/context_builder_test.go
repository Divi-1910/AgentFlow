package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/llm"
	"backend/memory"
	"backend/runtimectx"
	"backend/tools"
)

// ── Fakes ─────────────────────────────────────────────────────────────────────

type fakeMetaStore struct {
	mu   sync.Mutex
	docs []memory.MemoryDocument
}

func (f *fakeMetaStore) Upsert(_ context.Context, doc memory.MemoryDocument) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, d := range f.docs {
		// User-scope memories are keyed by (user_id, scope, memory_id),
		// matching the partial unique index in the real Mongo repo.
		if doc.Scope == memory.ScopeUser {
			if d.Scope == memory.ScopeUser && d.UserID == doc.UserID && d.ID == doc.ID {
				f.docs[i] = doc
				return nil
			}
			continue
		}
		if d.AgentID == doc.AgentID && d.Scope == doc.Scope && d.ID == doc.ID {
			f.docs[i] = doc
			return nil
		}
	}
	f.docs = append(f.docs, doc)
	return nil
}

func (f *fakeMetaStore) FindOne(_ context.Context, agentID, scope, memoryID string) (*memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.docs {
		if d.AgentID == agentID && d.Scope == scope && d.ID == memoryID {
			dc := d
			return &dc, nil
		}
	}
	return nil, nil
}

func (f *fakeMetaStore) FindOneUserScoped(_ context.Context, userID, memoryID string) (*memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var best *memory.MemoryDocument
	for i := range f.docs {
		d := f.docs[i]
		if d.Scope != memory.ScopeUser || d.UserID != userID || d.ID != memoryID {
			continue
		}
		if best == nil || d.CreatedAt.After(best.CreatedAt) {
			dc := d
			best = &dc
		}
	}
	return best, nil
}

func (f *fakeMetaStore) FindActive(_ context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, _ time.Time) ([]memory.MemoryDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []memory.MemoryDocument
	for _, d := range f.docs {
		if !scopeVisible(execScope, searchScope, d) {
			continue
		}
		if typeFilter != nil && d.Type != *typeFilter {
			continue
		}
		out = append(out, d)
	}
	return out, nil
}

func scopeVisible(execScope runtimectx.MemoryScope, searchScope string, d memory.MemoryDocument) bool {
	switch searchScope {
	case memory.ScopeThread:
		return d.Scope == memory.ScopeThread && d.AgentID == execScope.AgentID && d.ThreadID == execScope.ThreadID
	case memory.ScopeAgent:
		if d.Scope == memory.ScopeAgent && d.AgentID == execScope.AgentID {
			return true
		}
		if d.Scope == memory.ScopeThread && d.AgentID == execScope.AgentID && d.ThreadID == execScope.ThreadID {
			return true
		}
		return false
	case memory.ScopeUser:
		if d.Scope == memory.ScopeUser && d.UserID == execScope.UserID {
			return true
		}
		if d.Scope == memory.ScopeAgent && d.AgentID == execScope.AgentID {
			return true
		}
		if d.Scope == memory.ScopeThread && d.AgentID == execScope.AgentID && d.ThreadID == execScope.ThreadID {
			return true
		}
		return false
	}
	return false
}

func (f *fakeMetaStore) StampRead(_ context.Context, _, _, _ string) error { return nil }
func (f *fakeMetaStore) FindExpired(_ context.Context, _ time.Time) ([]memory.MemoryDocument, error) {
	return nil, nil
}
func (f *fakeMetaStore) SoftDelete(_ context.Context, _, _, _ string) error { return nil }
func (f *fakeMetaStore) EnsureIndexes(_ context.Context) error              { return nil }

// ── Helpers ───────────────────────────────────────────────────────────────────

func buildAgent(systemPrompt string, toolNames ...string) *Agent {
	return &Agent{
		ID:           "agent-1",
		Name:         "test-agent",
		SystemPrompt: systemPrompt,
		Tools:        toolNames,
		MaxSteps:     7,
	}
}

func buildRunCtx(input string) RunContext {
	return RunContext{
		RunID:    "run-1",
		ThreadID: "thread-1",
		Input:    input,
		Memory:   runtimectx.MemoryScope{UserID: "user-1", AgentID: "agent-1", ThreadID: "thread-1"},
	}
}

func buildBuilder(t *testing.T, meta *fakeMetaStore) *ContextBuilder {
	t.Helper()
	return &ContextBuilder{
		platform:  &PlatformConfig{Body: "<platform>static body</platform>"},
		metaStore: meta,
		now:       func() time.Time { return time.Date(2026, 5, 17, 12, 0, 0, 0, time.UTC) },
	}
}

// defsFor builds the per-run tool definitions for an agent (the toolDefs the
// runtime now passes into Build), from a registry holding calculator + http.
func defsFor(ag *Agent) []llm.ToolDefinition {
	reg := tools.NewEmptyRegistry()
	reg.Register(tools.NewCalculatorTool())
	reg.Register(tools.NewHTTPTool(0, nil))
	ts, err := BuildToolSetForValidation(reg, ag)
	if err != nil {
		panic(err)
	}
	return ts.Definitions()
}

func systemContent(t *testing.T, msgs []llm.ChatMessage) string {
	t.Helper()
	if len(msgs) == 0 || msgs[0].Role != "system" {
		t.Fatalf("expected first message to be system, got %v", msgs)
	}
	return msgs[0].Content
}

// ── Static prefix identity ────────────────────────────────────────────────────

func TestBuildStaticPrefixIsIdenticalAcrossDifferentRunContexts(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("Agent system prompt.", "calculator")

	a, err := cb.Build(context.Background(), ag, buildRunCtx("hello"), defsFor(ag))
	if err != nil {
		t.Fatalf("build #1: %v", err)
	}
	b, err := cb.Build(context.Background(), ag, buildRunCtx("totally different input"), defsFor(ag))
	if err != nil {
		t.Fatalf("build #2: %v", err)
	}

	sa := systemContent(t, a)
	sb := systemContent(t, b)

	// The static prefix runs from the start of the system message up to (but
	// not including) the <user_preferences> or <context> blocks. Everything
	// up to "<context>" must match byte-for-byte.
	prefix := func(s string) string {
		i := strings.Index(s, "<context>")
		if i == -1 {
			return s
		}
		return s[:i]
	}

	if prefix(sa) != prefix(sb) {
		t.Errorf("static prefix changed between builds.\nA:\n%s\nB:\n%s", prefix(sa), prefix(sb))
	}
}

func TestBuildSkipsEmptyFreshInputButKeepsSystemContext(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("Agent system prompt.")
	rc := buildRunCtx("")
	rc.SystemContext = "A background task you started earlier has finished. Share this result with the user."

	msgs, err := cb.Build(context.Background(), ag, rc, defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("messages = %+v, want only the system message", msgs)
	}
	if msgs[0].Role != "system" {
		t.Fatalf("first message role = %q, want system", msgs[0].Role)
	}
	if !strings.Contains(msgs[0].Content, "<system_context>") {
		t.Fatalf("system context missing from system message:\n%s", msgs[0].Content)
	}
	for _, msg := range msgs {
		if msg.Role == "user" && strings.TrimSpace(msg.Content) == "" {
			t.Fatalf("empty user message emitted: %+v", msgs)
		}
	}
}

// ── Tool instructions filtering ───────────────────────────────────────────────

func TestBuildToolInstructionsIncludesOnlyAgentTools(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("agent.", "calculator") // calculator has Instructions

	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	if !strings.Contains(sys, "<tool_instructions>") {
		t.Errorf("expected <tool_instructions> block, got:\n%s", sys)
	}
	if !strings.Contains(sys, "<calculator>") {
		t.Errorf("expected <calculator> entry inside tool_instructions, got:\n%s", sys)
	}
	// http_request is not in agent.Tools, so it must not appear.
	if strings.Contains(sys, "<http_request>") {
		t.Errorf("unexpected <http_request> entry — agent does not have this tool. Got:\n%s", sys)
	}
}

func TestBuildElidesToolInstructionsWhenAgentHasNoTools(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("agent.")

	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(systemContent(t, msgs), "<tool_instructions>") {
		t.Errorf("unexpected <tool_instructions> block for agent with no tools")
	}
}

// ── Memories index ordering & capping ─────────────────────────────────────────

func TestBuildMemoriesIndexIsOrderedByLastReadDescAndCapped(t *testing.T) {
	t.Parallel()
	meta := &fakeMetaStore{}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	// Insert 20 agent-scoped memories with increasing LastReadAt.
	for i := 0; i < 20; i++ {
		lr := base.Add(time.Duration(i) * time.Hour)
		_ = meta.Upsert(context.Background(), memory.MemoryDocument{
			UserID:     "user-1",
			AgentID:    "agent-1",
			ThreadID:   "thread-1",
			ID:         fmt.Sprintf("mem-%02d", i),
			Type:       memory.TypeFact,
			Scope:      memory.ScopeAgent,
			CreatedAt:  base,
			LastReadAt: &lr,
			Summary:    fmt.Sprintf("preview-%02d", i),
		})
	}

	cb := buildBuilder(t, meta)
	ag := buildAgent("a.")

	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	// Newest (mem-19) must appear before oldest (mem-00).
	idx19 := strings.Index(sys, "mem-19")
	idx00 := strings.Index(sys, "mem-00")
	if idx19 == -1 {
		t.Fatalf("expected mem-19 in output, got:\n%s", sys)
	}
	if idx00 != -1 && idx00 < idx19 {
		t.Errorf("ordering wrong: mem-00 appears before mem-19")
	}
	// Capped at memoriesIndexLimit (15).
	if count := strings.Count(sys, "<memory id="); count != memoriesIndexLimit {
		t.Errorf("expected %d <memory> entries, got %d", memoriesIndexLimit, count)
	}
	// Older entries past the cap should be excluded.
	if strings.Contains(sys, "mem-04") {
		t.Errorf("expected mem-04 (the 5th oldest) to be dropped past the 15-entry cap")
	}
}

// ── Tool result truncation ────────────────────────────────────────────────────

func TestBuildPreservesLargeToolResultsCanonically(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("a.")
	rc := buildRunCtx("x")
	huge := strings.Repeat("X", toolResultTruncateChars+500)
	rc.History = []llm.ChatMessage{
		{Role: "user", Content: "earlier user message"},
		{Role: "assistant", Content: "I'll search."},
		{Role: "tool", ToolCallID: "c1", Content: huge},
	}

	msgs, err := cb.Build(context.Background(), ag, rc, defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages, got %d", len(msgs))
	}
	// Build returns canonical state — truncation is display-only and
	// happens via RenderForLLM at LLM-call time.
	if len(msgs[3].Content) != len(huge) {
		t.Errorf("Build should preserve full tool content for canonical state. got len=%d, want %d",
			len(msgs[3].Content), len(huge))
	}
}

func TestRenderForLLMTruncatesLargeToolResults(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	huge := strings.Repeat("X", toolResultTruncateChars+500)
	canonical := []llm.ChatMessage{
		{Role: "system", Content: "sys"},
		{Role: "user", Content: "hi"},
		{Role: "tool", ToolCallID: "c1", Content: huge},
	}
	rendered := cb.RenderForLLM(canonical)
	if len(rendered) != len(canonical) {
		t.Fatalf("length mismatch")
	}
	if len(rendered[2].Content) >= len(huge) {
		t.Errorf("tool message not truncated for LLM: len=%d, original=%d",
			len(rendered[2].Content), len(huge))
	}
	if !strings.Contains(rendered[2].Content, "truncated") {
		t.Errorf("expected truncation marker in rendered tool content")
	}
	// Canonical slice must be untouched.
	if len(canonical[2].Content) != len(huge) {
		t.Errorf("RenderForLLM mutated source: len=%d, want %d", len(canonical[2].Content), len(huge))
	}
}

func TestRenderForLLMLeavesSmallToolResultsUnchanged(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	canonical := []llm.ChatMessage{
		{Role: "tool", ToolCallID: "c1", Content: "small result"},
	}
	rendered := cb.RenderForLLM(canonical)
	if rendered[0].Content != "small result" {
		t.Errorf("unexpected modification of small tool result: %q", rendered[0].Content)
	}
}

func TestRenderForLLMTruncatesOnRuneBoundary(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	// Multi-byte runes. Byte slicing would corrupt the boundary; rune
	// slicing must keep the prefix valid UTF-8 and at the expected length.
	multibyte := strings.Repeat("漢", toolResultTruncateChars+100)
	canonical := []llm.ChatMessage{{Role: "tool", Content: multibyte}}
	rendered := cb.RenderForLLM(canonical)

	idx := strings.Index(rendered[0].Content, "\n\n[...truncated")
	if idx == -1 {
		t.Fatalf("missing truncation marker, content prefix: %q", rendered[0].Content[:50])
	}
	head := rendered[0].Content[:idx]
	if got := len([]rune(head)); got != toolResultTruncateChars {
		t.Errorf("head length: got %d runes, want %d", got, toolResultTruncateChars)
	}
	// All bytes in the head must form valid UTF-8 of the original character.
	if strings.Count(head, "漢") != toolResultTruncateChars {
		t.Errorf("head contained partially split UTF-8 sequences (count: %d)", strings.Count(head, "漢"))
	}
}

// ── Checkpoint vs fresh parity ────────────────────────────────────────────────

func TestBuildSystemMessageIsIdenticalAcrossCheckpointAndFresh(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("agent.", "calculator")

	fresh, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build fresh: %v", err)
	}

	rc := buildRunCtx("x")
	rc.Checkpoint = &RunSnapshot{
		State: RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "x"}},
			StepsCompleted: 0,
		},
		Meta: SnapshotMeta{Phase: PhasePreModel},
	}
	resumed, err := cb.Build(context.Background(), ag, rc, defsFor(ag))
	if err != nil {
		t.Fatalf("build resume: %v", err)
	}

	if systemContent(t, fresh) != systemContent(t, resumed) {
		t.Errorf("system message differs between fresh and resume paths.\nfresh:\n%s\nresumed:\n%s",
			systemContent(t, fresh), systemContent(t, resumed))
	}
}

// ── Empty layer elision ───────────────────────────────────────────────────────

func TestBuildOmitsEmptyLayers(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("a.")

	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	if strings.Contains(sys, "<user_preferences>") {
		t.Errorf("expected <user_preferences> to be elided when no user memories exist")
	}
	if strings.Contains(sys, "<memories>") {
		t.Errorf("expected <memories> to be elided when no agent/thread memories exist")
	}
}

// ── Instructions exclusion from JSON ──────────────────────────────────────────

func TestToolDefinitionInstructionsExcludedFromJSON(t *testing.T) {
	t.Parallel()
	def := tools.NewCalculatorTool().Definition()
	if strings.TrimSpace(def.Instructions) == "" {
		t.Fatal("calculator tool must have non-empty Instructions for this test to be meaningful")
	}
	raw, err := json.Marshal(def)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "Instructions") || strings.Contains(string(raw), "instructions") {
		t.Errorf("serialized ToolDefinition leaked the Instructions field:\n%s", string(raw))
	}
}

// ── Cross-agent user preferences (regression for review issue #2) ────────────

// buildBuilderWithService creates a ContextBuilder backed by a real
// memory.Service rooted at a fresh temp dir. Memory files written via
// writeMemoryFile show up through Service.ReadByMeta in the builder's
// renderUserPreferences path.
func buildBuilderWithService(t *testing.T, meta *fakeMetaStore) (*ContextBuilder, string) {
	t.Helper()
	root := t.TempDir()
	svc := memory.NewService(memory.Config{Root: root}, meta)
	cb := &ContextBuilder{
		platform:   &PlatformConfig{Body: "<platform>p</platform>"},
		memService: svc,
		metaStore:  meta,
		now:        func() time.Time { return time.Date(2026, 5, 17, 12, 0, 0, 0, time.UTC) },
	}
	return cb, root
}

func writeMemoryFile(t *testing.T, root, userID, scope, scopeID, memoryID, body string) {
	t.Helper()
	var dir string
	switch scope {
	case memory.ScopeUser:
		dir = filepath.Join(root, userID, memory.ScopeUser)
	case memory.ScopeAgent:
		dir = filepath.Join(root, userID, memory.ScopeAgent, scopeID)
	case memory.ScopeThread:
		dir = filepath.Join(root, userID, memory.ScopeThread, scopeID)
	default:
		t.Fatalf("unknown scope %q", scope)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, memoryID+".md"), []byte(body), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
}

func TestBuildSurfacesUserPreferencesAcrossAgents(t *testing.T) {
	t.Parallel()
	meta := &fakeMetaStore{}
	cb, root := buildBuilderWithService(t, meta)

	// Memory written by agent-B in thread-B for user-1. The current run uses
	// agent-A in thread-1. The doc carries the writer's full scope (as it
	// would in Mongo) — but the file path for ScopeUser is keyed only on
	// UserID, so the reader can still hydrate it.
	otherAgentBody := "User prefers Hindi for casual chats."
	writeMemoryFile(t, root, "user-1", memory.ScopeUser, "", "lang-pref", otherAgentBody)
	_ = meta.Upsert(context.Background(), memory.MemoryDocument{
		UserID:    "user-1",
		AgentID:   "agent-B", // different agent wrote it
		ThreadID:  "thread-B",
		ID:        "lang-pref",
		Type:      memory.TypePreference,
		Scope:     memory.ScopeUser,
		CreatedAt: time.Now().UTC(),
	})

	// Memory written by agent-1 (the current run's agent) for the same user.
	sameAgentBody := "User likes bullet points."
	writeMemoryFile(t, root, "user-1", memory.ScopeUser, "", "fmt-pref", sameAgentBody)
	_ = meta.Upsert(context.Background(), memory.MemoryDocument{
		UserID:    "user-1",
		AgentID:   "agent-1",
		ThreadID:  "thread-1",
		ID:        "fmt-pref",
		Type:      memory.TypePreference,
		Scope:     memory.ScopeUser,
		CreatedAt: time.Now().UTC(),
	})

	ag := buildAgent("a.")
	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("hi"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	if !strings.Contains(sys, otherAgentBody) {
		t.Errorf("cross-agent user memory missing from <user_preferences>:\n%s", sys)
	}
	if !strings.Contains(sys, sameAgentBody) {
		t.Errorf("same-agent user memory missing from <user_preferences>:\n%s", sys)
	}
}

// ── User-preferences cap (regression for review issue #3) ────────────────────

func TestBuildCapsUserPreferencesByCountAndBudget(t *testing.T) {
	t.Parallel()
	meta := &fakeMetaStore{}
	cb, root := buildBuilderWithService(t, meta)

	// Inject 60 user-scoped memories with 400-char bodies each. Without caps
	// the rendered block would be ~24,000 chars.
	body := strings.Repeat("y", 400)
	for i := 0; i < 60; i++ {
		id := fmt.Sprintf("u-%02d", i)
		writeMemoryFile(t, root, "user-1", memory.ScopeUser, "", id, body+" "+id)
		lr := time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		_ = meta.Upsert(context.Background(), memory.MemoryDocument{
			UserID:     "user-1",
			AgentID:    "agent-1",
			ThreadID:   "thread-1",
			ID:         id,
			Type:       memory.TypePreference,
			Scope:      memory.ScopeUser,
			CreatedAt:  lr,
			LastReadAt: &lr,
		})
	}

	ag := buildAgent("a.")
	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	prefStart := strings.Index(sys, "<user_preferences>")
	prefEnd := strings.Index(sys, "</user_preferences>")
	if prefStart == -1 || prefEnd == -1 {
		t.Fatalf("missing <user_preferences> block")
	}
	block := sys[prefStart : prefEnd+len("</user_preferences>")]
	// Block must be bounded — generous slack for tags + truncation marker.
	if len(block) > userPrefsTotalBudgetChars+1500 {
		t.Errorf("<user_preferences> exceeded budget: len=%d, cap=%d",
			len(block), userPrefsTotalBudgetChars+1500)
	}
	count := strings.Count(block, "<preference id=")
	if count > userPrefsMaxCount {
		t.Errorf("<user_preferences> count exceeds userPrefsMaxCount: %d > %d", count, userPrefsMaxCount)
	}
	// The "elided" note should be present because we injected far more than
	// the budget/count can hold.
	if !strings.Contains(block, "elided") {
		t.Errorf("expected an 'elided' note when many memories overflow budget; block:\n%s", block)
	}
}

// ── Count-cap overflow surfaces an elision note (regression review round 2) ──

func TestBuildEmitsElidedNoteOnCountCapOverflow(t *testing.T) {
	t.Parallel()
	meta := &fakeMetaStore{}
	cb, root := buildBuilderWithService(t, meta)

	// 26 tiny preferences (1 above userPrefsMaxCount). Each body is short
	// enough that the total-budget cap never kicks in; only the count cap
	// drops a memory. The elision note must still appear.
	excess := userPrefsMaxCount + 1
	for i := 0; i < excess; i++ {
		id := fmt.Sprintf("tiny-%02d", i)
		body := fmt.Sprintf("pref %d", i)
		writeMemoryFile(t, root, "user-1", memory.ScopeUser, "", id, body)
		lr := time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		_ = meta.Upsert(context.Background(), memory.MemoryDocument{
			UserID:     "user-1",
			AgentID:    "agent-1",
			ThreadID:   "thread-1",
			ID:         id,
			Type:       memory.TypePreference,
			Scope:      memory.ScopeUser,
			CreatedAt:  lr,
			LastReadAt: &lr,
		})
	}

	ag := buildAgent("a.")
	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	prefStart := strings.Index(sys, "<user_preferences>")
	prefEnd := strings.Index(sys, "</user_preferences>")
	if prefStart == -1 || prefEnd == -1 {
		t.Fatalf("missing <user_preferences> block")
	}
	block := sys[prefStart : prefEnd+len("</user_preferences>")]
	if count := strings.Count(block, "<preference id="); count != userPrefsMaxCount {
		t.Errorf("rendered preference count: got %d, want %d", count, userPrefsMaxCount)
	}
	if !strings.Contains(block, "elided") {
		t.Errorf("expected 'elided' note when count cap overflows. block:\n%s", block)
	}
	if !strings.Contains(block, fmt.Sprintf("%d additional", excess-userPrefsMaxCount)) {
		t.Errorf("elision note should mention exactly %d dropped memories. block:\n%s",
			excess-userPrefsMaxCount, block)
	}
}

// ── Resume preserves canonical tool output (regression for review issue #4) ──

func TestBuildOnResumeKeepsLargeToolResultsCanonical(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("a.")
	huge := strings.Repeat("X", toolResultTruncateChars+1000)
	rc := buildRunCtx("ignored on resume")
	rc.Checkpoint = &RunSnapshot{
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "hi"},
				{Role: "assistant", Content: "searching", ToolCalls: []llm.ToolCall{{ID: "c1", Name: "calculator"}}},
				{Role: "tool", ToolCallID: "c1", Content: huge},
			},
			StepsCompleted: 1,
		},
		Meta: SnapshotMeta{Phase: PhasePreModel},
	}

	msgs, err := cb.Build(context.Background(), ag, rc, defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages (sys + 3 snapshot), got %d", len(msgs))
	}
	// The tool message must be canonical (untruncated). RenderForLLM is the
	// only place that should truncate, and it returns a copy.
	if len(msgs[3].Content) != len(huge) {
		t.Errorf("resume truncated canonical tool content: len=%d, want %d",
			len(msgs[3].Content), len(huge))
	}
}

// ── XML escaping ──────────────────────────────────────────────────────────────

func TestBuildEscapesAngleBracketsInAgentPrompt(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("prompt with </agent> early-close attempt")

	msgs, err := cb.Build(context.Background(), ag, buildRunCtx("x"), defsFor(ag))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	sys := systemContent(t, msgs)
	if strings.Count(sys, "</agent>") != 1 {
		t.Errorf("expected exactly one </agent> closing tag (escaped user content), got %d.\nFull:\n%s",
			strings.Count(sys, "</agent>"), sys)
	}
}
