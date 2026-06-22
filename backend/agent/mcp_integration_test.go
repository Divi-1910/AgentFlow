package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"backend/llm"
	"backend/tools"
)

// fakeMCPTool stands in for a discovered MCP tool (AddMCPTools marks any
// tools.Tool as toolKindMCP regardless of concrete type).
type fakeMCPTool struct{ name string }

func (f fakeMCPTool) Name() string { return f.name }
func (f fakeMCPTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{Name: f.name, Description: "fake mcp tool", Parameters: json.RawMessage(`{"type":"object"}`)}
}
func (f fakeMCPTool) Execute(context.Context, tools.ToolCall) (*tools.ToolResult, error) {
	return &tools.ToolResult{Content: "ok"}, nil
}

func hasMCPName(refs []ToolRef) bool {
	for _, r := range refs {
		if strings.HasPrefix(r.Name, tools.MCPToolPrefix) {
			return true
		}
	}
	return false
}

// Contract b: MCP tools are in Definitions()/Get() but excluded from the resume
// identity (Refs()/Version()).
func TestToolSet_MCPExcludedFromResumeIdentity(t *testing.T) {
	t.Parallel()
	ag := &Agent{ID: "a", Tools: []string{"calculator"}}
	ts, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag, ToolCapabilities{AsyncJobs: true}, nil)
	if err != nil {
		t.Fatalf("BuildToolSet: %v", err)
	}
	versionBefore := ts.Version()
	refsBefore := len(ts.Refs())

	ts.AddMCPTools([]tools.Tool{fakeMCPTool{name: "mcp__demo__echo"}})

	if _, ok := ts.Get("mcp__demo__echo"); !ok {
		t.Fatal("MCP tool missing from Get()")
	}
	var inDefs bool
	for _, d := range ts.Definitions() {
		if d.Name == "mcp__demo__echo" {
			inDefs = true
		}
	}
	if !inDefs {
		t.Fatal("MCP tool missing from Definitions()")
	}
	if ts.Version() != versionBefore {
		t.Fatal("Version() changed after AddMCPTools — MCP must be excluded from the resume identity")
	}
	if len(ts.Refs()) != refsBefore || hasMCPName(ts.Refs()) {
		t.Fatalf("MCP tool leaked into Refs(): %+v", ts.Refs())
	}
}

// Contract a2: the resume-validation builder never sees MCP (no discovery),
// even for an agent that has MCPServers configured.
func TestBuildToolSetForValidation_IgnoresMCPServers(t *testing.T) {
	t.Parallel()
	ag := &Agent{
		ID:         "a",
		Tools:      []string{"calculator"},
		MCPServers: []MCPServerConfig{{Alias: "demo", URL: "https://example.com/mcp"}},
	}
	ts, err := BuildToolSetForValidation(toolsetTestRegistry(), ag, ToolCapabilities{AsyncJobs: true})
	if err != nil {
		t.Fatalf("BuildToolSetForValidation: %v", err)
	}
	for _, n := range ts.Names() {
		if strings.HasPrefix(n, tools.MCPToolPrefix) {
			t.Fatalf("validation toolset contains MCP tool %q", n)
		}
	}
}

// Reviewer High finding: a checkpoint at post_model with a PENDING mcp__ tool
// call must DEGRADE (synthesize a soft IsError result and continue) when the
// server is unavailable on resume — not hard-fail. (newTestRuntime has no
// mcpManager, so the mcp tool is absent from the rebuilt toolset.)
func TestResumePostModelPendingMCPCallDegrades(t *testing.T) {
	t.Parallel()
	snap := RunSnapshot{
		Version: 1,
		RunID:   "run-mcp-resume",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "use the demo tool"},
				{Role: "assistant", ToolCalls: []llm.ToolCall{{
					ID: "tc-mcp", Name: "mcp__demo__echo", Arguments: json.RawMessage(`{"msg":"hi"}`),
				}}},
			},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{},
		},
		Meta: SnapshotMeta{Phase: PhasePostModel, EffectiveTools: ToolRefList{{Name: "calculator"}}},
	}
	lm := &fakeLLM{replies: []fakeReply{textReply("done without the tool")}}
	rt, ag := newTestRuntime(lm, nil)
	sink := &captureEventSink{}

	runCtx := newTestRunCtx("")
	runCtx.RunID = "run-mcp-resume"
	runCtx.Checkpoint = &snap

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)
	if err != nil {
		t.Fatalf("resume with an unavailable pending MCP call must degrade, not fail: %v", err)
	}
	if result.Output != "done without the tool" {
		t.Fatalf("output = %q", result.Output)
	}
	var found bool
	for _, m := range result.NewMessages {
		if m.Role == "tool" && m.ToolCallID == "tc-mcp" {
			found = true
			if ie, _ := m.Metadata["is_error"].(bool); !ie {
				t.Error("synthesized MCP tool result should be is_error=true")
			}
		}
	}
	if !found {
		t.Fatalf("no synthesized tool result for the missing MCP call; new messages = %+v", result.NewMessages)
	}
}

// Contract a + b2: a run that HAD MCP tools snapshots Refs() with no MCP entry,
// and resume validation (toolset with no MCP — server down / not rediscovered)
// succeeds.
func TestCanResume_SucceedsWithMCPServerDownOnResume(t *testing.T) {
	t.Parallel()
	ag := &Agent{ID: "a", Tools: []string{"calculator"}}

	runSet, _ := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag, ToolCapabilities{AsyncJobs: true}, nil)
	runSet.AddMCPTools([]tools.Tool{fakeMCPTool{name: "mcp__demo__echo"}})
	meta := SnapshotMeta{EffectiveTools: runSet.Refs(), ToolsetVersion: runSet.Version()}

	if hasMCPName(meta.EffectiveTools) { // b2: snapshot omits MCP
		t.Fatalf("snapshot EffectiveTools leaked an MCP tool: %+v", meta.EffectiveTools)
	}

	resumeSet, _ := BuildToolSetForValidation(toolsetTestRegistry(), ag, ToolCapabilities{AsyncJobs: true}) // no MCP
	if err := CanResume(meta, resumeSet); err != nil {
		t.Fatalf("resume must succeed despite MCP server being unavailable: %v", err)
	}
}

// Reviewer follow-up: a checkpoint whose message tail contains a prior MCP
// tool exchange resumes cleanly when the server is down — only <mcp_status>
// (rendered elsewhere) signals the absence; ValidateSnapshot doesn't block.
func TestResumeContinuity_PriorMCPMessagesServerDown(t *testing.T) {
	t.Parallel()
	ag := &Agent{ID: "a", Tools: []string{"calculator"}}

	runSet, _ := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag, ToolCapabilities{AsyncJobs: true}, nil)
	runSet.AddMCPTools([]tools.Tool{fakeMCPTool{name: "mcp__demo__echo"}})

	snap := &RunSnapshot{
		Version: 1,
		RunID:   "run-1",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "use the demo tool"},
				{Role: "assistant", Content: "calling mcp__demo__echo"},
				{Role: "tool", Content: "[mcp__demo__echo] prior result"},
			},
			MaxSteps:       25,
			StepsCompleted: 1,
		},
		Meta: SnapshotMeta{EffectiveTools: runSet.Refs(), ToolsetVersion: runSet.Version()},
	}

	resumeSet, _ := BuildToolSetForValidation(toolsetTestRegistry(), ag, ToolCapabilities{AsyncJobs: true}) // server down → no MCP
	if err := ValidateSnapshot(snap, resumeSet); err != nil {
		t.Fatalf("resume must proceed with prior MCP messages + server down: %v", err)
	}
}
