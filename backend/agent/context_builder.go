package agent

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"backend/llm"
	"backend/memory"
	"backend/runtimectx"
)

const (
	// memoriesIndexLimit caps how many agent/thread-scoped memories appear in
	// <context><memories><index>. The agent can fetch beyond this set via
	// memory_search and memory_read.
	memoriesIndexLimit = 15

	// toolResultTruncateChars is the soft cap on tool-result content injected
	// into history. Larger results are truncated to roughly 1000 tokens
	// (~4000 chars / ~4000 runes) — the agent can re-run a tool or use
	// memory_read to retrieve the full output on demand.
	toolResultTruncateChars = 4000

	// userPrefBodyMaxChars caps the rendered length of a single user-scoped
	// memory body inside <user_preferences>. Memories longer than this are
	// truncated with an explicit marker; the agent can call memory_read to
	// get the full content if needed.
	userPrefBodyMaxChars = 1000

	// userPrefsTotalBudgetChars caps the total rendered length of the
	// <user_preferences> block across all included memories. Once exceeded,
	// further memories are dropped (rendered as a one-line "more available"
	// notice) so a single user can't blow up the system prompt with hundreds
	// of long preferences.
	userPrefsTotalBudgetChars = 4000

	// userPrefsMaxCount caps how many user-scoped memories appear in the
	// <user_preferences> block before the budget kicks in. Acts as an upper
	// bound independent of body size.
	userPrefsMaxCount = 25
)

// ContextBuilder assembles the LLM message list for a single run.
//
// The output has two parts:
//
//   - A static prefix: <platform>, <agent>, <tool_instructions>. These are
//     byte-identical across every turn within a thread (provided the agent
//     config and tool registry have not changed), so the provider's
//     prompt-prefix cache can keep them warm.
//
//   - A dynamic suffix: <user_preferences>, <context> (state, summary,
//     memories index), then the conversation history and the current user
//     input.
//
// Build is the single source of truth for both fresh runs and checkpoint
// resumes — the same system message is produced in either path.
type ContextBuilder struct {
	platform   *PlatformConfig
	memService *memory.Service
	metaStore  memory.MetaStore
	now        func() time.Time
}

func NewContextBuilder(
	platform *PlatformConfig,
	memSvc *memory.Service,
	metaStore memory.MetaStore,
) *ContextBuilder {
	return &ContextBuilder{
		platform:   platform,
		memService: memSvc,
		metaStore:  metaStore,
		now:        func() time.Time { return time.Now().UTC() },
	}
}

// Build returns the canonical message list for a run: the rendered system
// message followed by the conversation tail.
//
// For fresh runs (runCtx.Checkpoint == nil) the tail is
// runCtx.History + the current user input.
//
// For checkpoint resumes the tail is the snapshot's message list
// (which already includes the original user input and any assistant /
// tool messages produced before the interruption).
//
// Build does NOT truncate tool results. The returned slice is the canonical
// state the runtime mutates and checkpoints; truncation is a display concern
// applied separately by RenderForLLM just before a ChatCompletion call.
func (cb *ContextBuilder) Build(ctx context.Context, agent *Agent, runCtx RunContext, toolDefs []llm.ToolDefinition) ([]llm.ChatMessage, error) {
	systemContent, err := cb.buildSystemContent(ctx, agent, runCtx, toolDefs)
	if err != nil {
		return nil, err
	}
	sysMsg := llm.ChatMessage{Role: "system", Content: systemContent}

	if runCtx.Checkpoint != nil {
		tail := runCtx.Checkpoint.State.Messages
		out := make([]llm.ChatMessage, 0, len(tail)+1)
		out = append(out, sysMsg)
		out = append(out, tail...)
		return out, nil
	}

	out := make([]llm.ChatMessage, 0, len(runCtx.History)+2)
	out = append(out, sysMsg)
	out = append(out, runCtx.History...)
	if strings.TrimSpace(runCtx.Input) != "" {
		out = append(out, llm.ChatMessage{Role: "user", Content: runCtx.Input})
	}
	return out, nil
}

// BuildSystemContent renders just the system-message body for the current
// (agent, runCtx). The runtime calls this before each ChatCompletion so the
// <state> block reflects live values (current step, phase, last action) while
// the static prefix stays byte-identical for prompt caching.
func (cb *ContextBuilder) BuildSystemContent(ctx context.Context, agent *Agent, runCtx RunContext, toolDefs []llm.ToolDefinition) (string, error) {
	return cb.buildSystemContent(ctx, agent, runCtx, toolDefs)
}

// RenderForLLM returns a copy of canonical with display-only truncation
// applied to tool-role messages whose Content exceeds toolResultTruncateChars.
// The input slice is not mutated.
func (cb *ContextBuilder) RenderForLLM(canonical []llm.ChatMessage) []llm.ChatMessage {
	return truncateToolResults(canonical)
}

func (cb *ContextBuilder) buildSystemContent(ctx context.Context, agent *Agent, runCtx RunContext, toolDefs []llm.ToolDefinition) (string, error) {
	var sb strings.Builder

	// ── Static prefix ─────────────────────────────────────────────────────────
	if cb.platform != nil && strings.TrimSpace(cb.platform.Body) != "" {
		sb.WriteString(cb.platform.Body)
		sb.WriteString("\n\n")
	}

	if s := strings.TrimSpace(agent.SystemPrompt); s != "" {
		sb.WriteString("<agent>\n")
		sb.WriteString(escapeXMLContent(s))
		sb.WriteString("\n</agent>\n\n")
	}

	if block := renderToolInstructions(toolDefs); block != "" {
		sb.WriteString(block)
		sb.WriteString("\n")
	}

	// ── Dynamic suffix ────────────────────────────────────────────────────────
	if block, err := cb.renderUserPreferences(ctx, runCtx); err != nil {
		return "", err
	} else if block != "" {
		sb.WriteString(block)
		sb.WriteString("\n")
	}

	contextBlock, err := cb.renderContextBlock(ctx, agent, runCtx)
	if err != nil {
		return "", err
	}
	if contextBlock != "" {
		sb.WriteString(contextBlock)
	}

	return strings.TrimRight(sb.String(), "\n"), nil
}

// renderToolInstructions emits <tool_instructions> for the run's effective
// tools (delegates included) whose Definition carries a non-empty Instructions
// string. Reads from the per-run tool definitions, not the global registry, so
// the prompt reflects exactly what the run can call.
func renderToolInstructions(toolDefs []llm.ToolDefinition) string {
	var inner strings.Builder
	for _, def := range toolDefs {
		instructions := strings.TrimSpace(def.Instructions)
		if instructions == "" {
			continue
		}
		fmt.Fprintf(&inner, "  <%s>\n    %s\n  </%s>\n",
			def.Name, escapeXMLContent(instructions), def.Name)
	}
	if inner.Len() == 0 {
		return ""
	}
	return "<tool_instructions>\n" + inner.String() + "</tool_instructions>\n"
}

// renderUserPreferences emits <user_preferences> with bodies of active
// user-scoped memories for the calling user, ordered by LastReadAt desc.
// The block is bounded by userPrefsMaxCount, userPrefBodyMaxChars per body,
// and userPrefsTotalBudgetChars overall so a high-volume user can't blow
// up the system prompt.
func (cb *ContextBuilder) renderUserPreferences(ctx context.Context, runCtx RunContext) (string, error) {
	if cb.metaStore == nil || cb.memService == nil {
		return "", nil
	}
	execScope := runCtx.Memory
	if execScope.UserID == "" {
		return "", nil
	}
	docs, err := cb.metaStore.FindActive(ctx, execScope, memory.ScopeUser, nil, false, cb.now())
	if err != nil {
		return "", fmt.Errorf("context builder: find user memories: %w", err)
	}
	// FindActive(ScopeUser) returns user + agent + thread per the expansion
	// rules; we only want the user-scoped subset here.
	userDocs := filterByScope(docs, memory.ScopeUser)
	if len(userDocs) == 0 {
		return "", nil
	}

	sort.SliceStable(userDocs, func(i, j int) bool {
		ti := recencyKey(userDocs[i])
		tj := recencyKey(userDocs[j])
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return userDocs[i].ID < userDocs[j].ID
	})
	dropped := 0
	if len(userDocs) > userPrefsMaxCount {
		dropped = len(userDocs) - userPrefsMaxCount
		userDocs = userDocs[:userPrefsMaxCount]
	}

	var inner strings.Builder
	totalChars := 0
	for _, doc := range userDocs {
		if totalChars >= userPrefsTotalBudgetChars {
			dropped++
			continue
		}
		body, err := cb.readBody(ctx, execScope, doc)
		if err != nil {
			// Skip unreadable memories rather than failing the whole run.
			continue
		}
		body = strings.TrimSpace(body)
		if body == "" {
			continue
		}
		body = truncateRunes(body, userPrefBodyMaxChars,
			"… [truncated; use memory_read to fetch full body]")
		entry := fmt.Sprintf("  <preference id=\"%s\">\n    %s\n  </preference>\n",
			escapeXMLAttr(doc.ID), escapeXMLContent(body))
		// Stop adding entries once the budget would be exceeded.
		if totalChars+len(entry) > userPrefsTotalBudgetChars && totalChars > 0 {
			dropped++
			continue
		}
		inner.WriteString(entry)
		totalChars += len(entry)
	}
	if inner.Len() == 0 {
		return "", nil
	}
	if dropped > 0 {
		fmt.Fprintf(&inner, "  <note>%d additional user memories elided to fit prompt budget; use memory_search to find them.</note>\n", dropped)
	}
	return "<user_preferences>\n" + inner.String() + "</user_preferences>\n", nil
}

// renderContextBlock emits <context> wrapping <state>, optional
// <system_context>, optional <summary>, and optional <memories>. <state> is
// always emitted; the others elide when empty.
func (cb *ContextBuilder) renderContextBlock(ctx context.Context, agent *Agent, runCtx RunContext) (string, error) {
	state := cb.renderState(agent, runCtx)

	var systemContext string
	if s := strings.TrimSpace(runCtx.SystemContext); s != "" {
		systemContext = fmt.Sprintf("  <system_context>\n    %s\n  </system_context>\n", escapeXMLContent(s))
	}

	var summary string
	if s := strings.TrimSpace(runCtx.Summary); s != "" {
		summary = fmt.Sprintf("  <summary>\n    %s\n  </summary>\n", escapeXMLContent(s))
	}

	memoriesBlock, err := cb.renderMemoriesIndex(ctx, runCtx)
	if err != nil {
		return "", err
	}

	if state == "" && systemContext == "" && summary == "" && memoriesBlock == "" {
		return "", nil
	}

	var sb strings.Builder
	sb.WriteString("<context>\n")
	if state != "" {
		sb.WriteString(state)
	}
	if systemContext != "" {
		sb.WriteString(systemContext)
	}
	if summary != "" {
		sb.WriteString(summary)
	}
	if memoriesBlock != "" {
		sb.WriteString(memoriesBlock)
	}
	sb.WriteString("</context>\n")
	return sb.String(), nil
}

func (cb *ContextBuilder) renderState(agent *Agent, runCtx RunContext) string {
	maxSteps := agent.MaxSteps
	if maxSteps == 0 {
		maxSteps = DefaultMaxSteps
	}
	// Use runCtx.StepsCompleted directly. The runtime promotes the
	// checkpoint's step counter into runCtx on resume, and then updates
	// runCtx.StepsCompleted before every model call. Reading from the
	// checkpoint here would freeze the displayed step at the snapshot's
	// value for the entire resumed run.
	step := runCtx.StepsCompleted
	phase := runCtx.Phase
	if phase == "" {
		phase = PhasePreModel
	}

	var lines []string
	lines = append(lines, fmt.Sprintf("    step: %d/%d", step, maxSteps))
	lines = append(lines, fmt.Sprintf("    phase: %s", phase))
	if la := strings.TrimSpace(runCtx.LastAction); la != "" {
		lines = append(lines, fmt.Sprintf("    last_action: %s", escapeXMLContent(la)))
	}
	lines = append(lines, fmt.Sprintf("    date: %s", cb.now().Format("2006-01-02")))
	if runCtx.ThreadID != "" {
		lines = append(lines, fmt.Sprintf("    thread_id: %s", runCtx.ThreadID))
	}
	if runCtx.RunID != "" {
		lines = append(lines, fmt.Sprintf("    run_id: %s", runCtx.RunID))
	}

	return "  <state>\n" + strings.Join(lines, "\n") + "\n  </state>\n"
}

// renderMemoriesIndex emits <memories><index> with up to memoriesIndexLimit
// agent- and thread-scoped memories, sorted by LastReadAt desc (CreatedAt
// breaks ties; falls back to CreatedAt when LastReadAt is nil). Each entry
// renders the memory ID and its Summary (first-line preview).
func (cb *ContextBuilder) renderMemoriesIndex(ctx context.Context, runCtx RunContext) (string, error) {
	if cb.metaStore == nil {
		return "", nil
	}
	execScope := runCtx.Memory
	if execScope.UserID == "" || execScope.AgentID == "" {
		return "", nil
	}
	docs, err := cb.metaStore.FindActive(ctx, execScope, memory.ScopeAgent, nil, false, cb.now())
	if err != nil {
		return "", fmt.Errorf("context builder: find agent/thread memories: %w", err)
	}
	// ScopeAgent expands to agent + thread; user-scoped is rendered separately
	// in <user_preferences>.
	indexed := make([]memory.MemoryDocument, 0, len(docs))
	for _, d := range docs {
		if d.Scope == memory.ScopeAgent || d.Scope == memory.ScopeThread {
			indexed = append(indexed, d)
		}
	}
	if len(indexed) == 0 {
		return "", nil
	}

	sort.SliceStable(indexed, func(i, j int) bool {
		ti := recencyKey(indexed[i])
		tj := recencyKey(indexed[j])
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return indexed[i].ID < indexed[j].ID
	})

	if len(indexed) > memoriesIndexLimit {
		indexed = indexed[:memoriesIndexLimit]
	}

	var sb strings.Builder
	sb.WriteString("  <memories>\n    <index>\n")
	for _, d := range indexed {
		summary := strings.TrimSpace(d.Summary)
		if summary == "" {
			fmt.Fprintf(&sb, "      <memory id=\"%s\" scope=\"%s\"/>\n",
				escapeXMLAttr(d.ID), d.Scope)
			continue
		}
		fmt.Fprintf(&sb, "      <memory id=\"%s\" scope=\"%s\">%s</memory>\n",
			escapeXMLAttr(d.ID), d.Scope, escapeXMLContent(summary))
	}
	sb.WriteString("    </index>\n  </memories>\n")
	return sb.String(), nil
}

// readBody fetches a memory body via Service.ReadByMeta, which reads the
// projected body_path from the document's own metadata. This is critical for
// user-scoped memories: they may have been written by a different agent for
// the same user, so the current run's AgentID must not gate access.
// ReadByMeta also does not stamp last_read_at — appropriate for context
// injection (we are not officially "reading" on the agent's behalf).
func (cb *ContextBuilder) readBody(ctx context.Context, _ runtimectx.MemoryScope, doc memory.MemoryDocument) (string, error) {
	return cb.memService.ReadByMeta(ctx, doc)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func filterByScope(docs []memory.MemoryDocument, scope string) []memory.MemoryDocument {
	out := make([]memory.MemoryDocument, 0, len(docs))
	for _, d := range docs {
		if d.Scope == scope {
			out = append(out, d)
		}
	}
	return out
}

func recencyKey(d memory.MemoryDocument) time.Time {
	if d.LastReadAt != nil {
		return *d.LastReadAt
	}
	return d.CreatedAt
}

// truncateToolResults returns a copy of msgs in which any tool-role message
// whose Content (in runes) exceeds toolResultTruncateChars is shortened to a
// head excerpt plus a marker line. Non-tool messages are passed through
// unchanged. The input slice and its messages are not mutated; this is a
// display-only transform applied just before sending to the LLM.
func truncateToolResults(msgs []llm.ChatMessage) []llm.ChatMessage {
	out := make([]llm.ChatMessage, len(msgs))
	for i, m := range msgs {
		if m.Role != "tool" {
			out[i] = m
			continue
		}
		runes := []rune(m.Content)
		if len(runes) <= toolResultTruncateChars {
			out[i] = m
			continue
		}
		omitted := len(runes) - toolResultTruncateChars
		truncated := m // shallow copy; ToolCalls/Metadata never mutated here
		truncated.Content = fmt.Sprintf(
			"%s\n\n[...truncated %d chars. Re-run the tool with narrower input or use memory_read for the full payload.]",
			string(runes[:toolResultTruncateChars]), omitted,
		)
		out[i] = truncated
	}
	return out
}

// truncateRunes shortens s to at most maxRunes runes, appending suffix when
// truncation occurs. Operates on []rune so multi-byte UTF-8 sequences are
// never split mid-rune.
func truncateRunes(s string, maxRunes int, suffix string) string {
	if maxRunes <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	return string(r[:maxRunes]) + suffix
}

// EstimateSystemPromptTokens returns an approximate token cost for the system
// message that Build would render for (agent, runCtx). It uses the same
// 4-chars-per-token heuristic as the runtime's existing estimators. The
// system message is rendered once and discarded — callers that want the
// actual bytes should use Build / BuildSystemContent.
func (cb *ContextBuilder) EstimateSystemPromptTokens(ctx context.Context, agent *Agent, runCtx RunContext, toolDefs []llm.ToolDefinition) int {
	content, err := cb.buildSystemContent(ctx, agent, runCtx, toolDefs)
	if err != nil {
		return 0
	}
	return len([]rune(content)) / 4
}

// escapeXMLContent escapes the bare minimum so embedded text doesn't break the
// XML envelope. We deliberately do not require well-formed XML — LLMs are
// tolerant — but a literal "</agent>" inside a user-authored prompt would
// close the section early, hence the escape of '<' and '>'.
func escapeXMLContent(s string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
	)
	return replacer.Replace(s)
}

func escapeXMLAttr(s string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
	)
	return replacer.Replace(s)
}
