package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"backend/llm"
	"backend/scratchpad"
)

func newScratchpad(t *testing.T) *scratchpad.Service {
	t.Helper()
	return scratchpad.NewService(scratchpad.Config{Root: t.TempDir(), RGPath: "rg"})
}

func builderWithScratchpad(sp *scratchpad.Service) *ContextBuilder {
	return &ContextBuilder{
		platform:      &PlatformConfig{Body: "<platform>static body</platform>"},
		metaStore:     &fakeMetaStore{},
		scratchpadSvc: sp,
		now:           func() time.Time { return time.Date(2026, 5, 17, 12, 0, 0, 0, time.UTC) },
	}
}

// buildSubagentRunCtx mirrors buildRunCtx but with the delegation-tree fields a
// child run carries (ParentRunID set ⇒ subagent).
func buildSubagentRunCtx(input string) RunContext {
	rc := buildRunCtx(input)
	rc.ParentRunID = "run-parent"
	rc.OriginatorRunID = "run-orig"
	rc.InvocationKind = "sync_delegate"
	return rc
}

func prefixUpToContext(s string) string {
	if i := strings.Index(s, "<context>"); i != -1 {
		return s[:i]
	}
	return s
}

func TestCollaborationBlockForSubagent(t *testing.T) {
	cb := builderWithScratchpad(newScratchpad(t))
	ag := buildAgent("Agent system prompt.")

	out, err := cb.BuildSystemContent(context.Background(), ag, buildSubagentRunCtx("research the topic"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "<collaboration>") {
		t.Fatal("subagent run missing <collaboration> block")
	}
	if !strings.Contains(out, "parent_run_id: run-parent") {
		t.Fatal("collaboration block missing parent_run_id")
	}
	if !strings.Contains(out, "originator_run_id: run-orig") {
		t.Fatal("collaboration block missing originator_run_id")
	}
	if !strings.Contains(out, "delegated_task: research the topic") {
		t.Fatal("collaboration block missing delegated_task")
	}
}

func TestCollaborationBlockOmittedForTopLevel(t *testing.T) {
	cb := builderWithScratchpad(newScratchpad(t))
	ag := buildAgent("Agent system prompt.")

	// buildRunCtx has no ParentRunID → top-level.
	out, err := cb.BuildSystemContent(context.Background(), ag, buildRunCtx("top level task"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "<collaboration>") {
		t.Fatal("top-level run should not get a <collaboration> block")
	}
}

func TestCollaborationUsesCheckpointTaskOnResume(t *testing.T) {
	cb := builderWithScratchpad(newScratchpad(t))
	ag := buildAgent("Agent system prompt.")

	rc := buildSubagentRunCtx("") // empty Input ⇒ resume; task lives in the snapshot tail
	rc.Checkpoint = &RunSnapshot{
		State: RuntimeState{
			Messages: []llm.ChatMessage{{Role: "user", Content: "snapshot delegated task"}},
		},
	}
	out, err := cb.BuildSystemContent(context.Background(), ag, rc, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "<collaboration>") {
		t.Fatal("resume subagent should still get the collaboration block")
	}
	if !strings.Contains(out, "delegated_task: snapshot delegated task") {
		t.Fatal("collaboration block should recover delegated_task from checkpoint tail")
	}
}

func TestScratchpadPointerReflectsFileCount(t *testing.T) {
	sp := newScratchpad(t)
	cb := builderWithScratchpad(sp)
	ag := buildAgent("Agent system prompt.")
	rc := buildSubagentRunCtx("task")

	// Empty workspace ⇒ no pointer.
	out, err := cb.BuildSystemContent(context.Background(), ag, rc, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "<scratchpad>") {
		t.Fatal("empty workspace should not render the scratchpad pointer")
	}

	// Create a file in this run's workspace (user-1 / run-orig).
	ws := scratchpad.Workspace{UserID: rc.Memory.UserID, OriginatorRunID: rc.OriginatorRunID}
	if _, err := sp.Create(context.Background(), ws, "agent-1", scratchpad.CreateArgs{
		Title: "Plan", Heading: "Intro", Content: "body", RunID: "run-1", ToolCallID: "c1",
	}); err != nil {
		t.Fatal(err)
	}
	out, err = cb.BuildSystemContent(context.Background(), ag, rc, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "<scratchpad>") || !strings.Contains(out, "files: 1") {
		t.Fatalf("pointer missing or wrong count:\n%s", out)
	}
}

// The collaboration/scratchpad blocks are DYNAMIC: adding them must not perturb
// the static prefix (platform/agent/tool_instructions), or the prompt-prefix
// cache breaks.
func TestScratchpadBlocksDoNotChangeStaticPrefix(t *testing.T) {
	sp := newScratchpad(t)
	rc := buildSubagentRunCtx("task")
	ws := scratchpad.Workspace{UserID: rc.Memory.UserID, OriginatorRunID: rc.OriginatorRunID}
	if _, err := sp.Create(context.Background(), ws, "agent-1", scratchpad.CreateArgs{
		Title: "Plan", Heading: "Intro", Content: "body", RunID: "run-1", ToolCallID: "c1",
	}); err != nil {
		t.Fatal(err)
	}
	ag := buildAgent("Agent system prompt.")

	withSvc, err := builderWithScratchpad(sp).BuildSystemContent(context.Background(), ag, rc, nil)
	if err != nil {
		t.Fatal(err)
	}
	noSvc, err := buildBuilder(t, &fakeMetaStore{}).BuildSystemContent(context.Background(), ag, rc, nil)
	if err != nil {
		t.Fatal(err)
	}

	if prefixUpToContext(withSvc) != prefixUpToContext(noSvc) {
		t.Errorf("static prefix changed when scratchpad blocks added.\nWITH:\n%s\nNO:\n%s",
			prefixUpToContext(withSvc), prefixUpToContext(noSvc))
	}
	if !strings.Contains(withSvc, "<collaboration>") || !strings.Contains(withSvc, "<scratchpad>") {
		t.Fatal("with-service output should contain the dynamic blocks")
	}
	if strings.Contains(noSvc, "<collaboration>") || strings.Contains(noSvc, "<scratchpad>") {
		t.Fatal("nil-service builder must no-op both blocks")
	}
}
