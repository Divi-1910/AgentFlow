package tools_test

import (
	"context"
	"encoding/json"
	"testing"

	"backend/runtimectx"
	"backend/scratchpad"
	"backend/tools"
)

func spService(t *testing.T) *scratchpad.Service {
	t.Helper()
	return scratchpad.NewService(scratchpad.Config{Root: t.TempDir(), RGPath: "rg"})
}

// agentCtx builds the runtime context a tool sees: memory scope (user+agent)
// and delegation (originator). Agents in one task share OriginatorRunID/UserID
// but differ by AgentID — that is the shared-workspace key.
func agentCtx(agentID, originator string) context.Context {
	ctx := runtimectx.WithMemoryScope(context.Background(),
		runtimectx.MemoryScope{UserID: "u1", AgentID: agentID, ThreadID: "t1"})
	return runtimectx.WithDelegation(ctx,
		runtimectx.DelegationInfo{OriginatorRunID: originator, RunID: "run-" + agentID, UserID: "u1"})
}

func callTool(t *testing.T, tool tools.Tool, ctx context.Context, runID, callID string, args any) *tools.ToolResult {
	t.Helper()
	raw, _ := json.Marshal(args)
	res, err := tool.Execute(ctx, tools.ToolCall{ID: callID, RunID: runID, Args: raw})
	if err != nil {
		t.Fatalf("%s execute: %v", tool.Name(), err)
	}
	return res
}

func decodeOK(t *testing.T, res *tools.ToolResult, v any) {
	t.Helper()
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", res.Content)
	}
	if err := json.Unmarshal([]byte(res.Content), v); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestScratchpadToolsFullFlow(t *testing.T) {
	svc := spService(t)
	createT := tools.NewScratchpadCreateTool(svc)
	listT := tools.NewScratchpadListTool(svc)
	appendT := tools.NewScratchpadAppendTool(svc)
	getT := tools.NewScratchpadGetSectionsTool(svc)
	readT := tools.NewScratchpadReadSectionTool(svc)
	searchT := tools.NewScratchpadSearchTool(svc)
	replaceT := tools.NewScratchpadReplaceTool(svc)

	ctxA := agentCtx("A", "orig")
	ctxB := agentCtx("B", "orig") // different agent, different run, SAME task

	var created scratchpad.WriteResult
	decodeOK(t, callTool(t, createT, ctxA, "run-A", "c1",
		map[string]string{"title": "Plan", "heading": "Intro", "content": "alpha body"}), &created)
	if created.FileID == "" || !created.Created {
		t.Fatalf("create result = %+v", created)
	}

	var listed scratchpad.ListResult
	decodeOK(t, callTool(t, listT, ctxB, "run-B", "c1", map[string]any{}), &listed)
	if len(listed.Files) != 1 {
		t.Fatalf("B should see A's file via the shared workspace: %d files", len(listed.Files))
	}

	var appended scratchpad.WriteResult
	decodeOK(t, callTool(t, appendT, ctxB, "run-B", "c2",
		map[string]string{"file_id": created.FileID, "heading": "Correction", "content": "beta correction zeta-token"}), &appended)
	if appended.OwnerAgentID != "B" {
		t.Fatalf("append owner = %q", appended.OwnerAgentID)
	}

	var secs scratchpad.GetSectionsResult
	decodeOK(t, callTool(t, getT, ctxA, "run-A", "c2", map[string]string{"file_id": created.FileID}), &secs)
	if len(secs.Sections) != 2 {
		t.Fatalf("sections = %d, want 2", len(secs.Sections))
	}

	var rd scratchpad.ReadSectionResult
	decodeOK(t, callTool(t, readT, ctxA, "run-A", "c3",
		map[string]string{"file_id": created.FileID, "section_id": created.SectionID}), &rd)
	if rd.Content != "alpha body" {
		t.Fatalf("read content = %q", rd.Content)
	}

	var sr scratchpad.SearchResult
	decodeOK(t, callTool(t, searchT, ctxA, "run-A", "c4", map[string]string{"pattern": "zeta-token"}), &sr)
	if len(sr.Hits) != 1 || sr.Hits[0].AuthorAgentID != "B" {
		t.Fatalf("search hits = %+v", sr.Hits)
	}

	var replaced scratchpad.WriteResult
	decodeOK(t, callTool(t, replaceT, ctxA, "run-A", "c5",
		map[string]string{"file_id": created.FileID, "section_id": created.SectionID,
			"heading": "Intro", "content": "alpha v2", "expected_hash": created.ContentHash}), &replaced)
	if replaced.ContentHash == created.ContentHash {
		t.Fatal("replace did not change the content hash")
	}
}

func TestScratchpadReplaceNonOwnerIsError(t *testing.T) {
	svc := spService(t)
	createT := tools.NewScratchpadCreateTool(svc)
	replaceT := tools.NewScratchpadReplaceTool(svc)

	var created scratchpad.WriteResult
	decodeOK(t, callTool(t, createT, agentCtx("A", "orig"), "run-A", "c1",
		map[string]string{"title": "P", "heading": "H", "content": "a body"}), &created)

	// B attempts to replace A's section → tool surfaces an IsError result.
	res := callTool(t, replaceT, agentCtx("B", "orig"), "run-B", "c1",
		map[string]string{"file_id": created.FileID, "section_id": created.SectionID,
			"heading": "H", "content": "hijack", "expected_hash": created.ContentHash})
	if !res.IsError {
		t.Fatalf("non-owner replace should be IsError, got %s", res.Content)
	}
}

func TestScratchpadReplaceRequiresExpectedHash(t *testing.T) {
	svc := spService(t)
	createT := tools.NewScratchpadCreateTool(svc)
	replaceT := tools.NewScratchpadReplaceTool(svc)

	var created scratchpad.WriteResult
	decodeOK(t, callTool(t, createT, agentCtx("A", "orig"), "run-A", "c1",
		map[string]string{"title": "P", "heading": "H", "content": "a body"}), &created)

	res := callTool(t, replaceT, agentCtx("A", "orig"), "run-A", "c2",
		map[string]string{"file_id": created.FileID, "section_id": created.SectionID,
			"heading": "H", "content": "blind overwrite"})
	if !res.IsError {
		t.Fatalf("replace without expected_hash should be IsError, got %s", res.Content)
	}
}

func TestScratchpadWorkspaceContinuityAcrossRunIDs(t *testing.T) {
	svc := spService(t)
	createT := tools.NewScratchpadCreateTool(svc)
	appendT := tools.NewScratchpadAppendTool(svc)
	listT := tools.NewScratchpadListTool(svc)
	getT := tools.NewScratchpadGetSectionsTool(svc)

	originator := "origin-shared"
	ctxRoot := agentCtx("root-agent", originator)
	ctxAsync := agentCtx("async-agent", originator)
	ctxCallback := agentCtx("root-agent", originator)

	var created scratchpad.WriteResult
	decodeOK(t, callTool(t, createT, ctxRoot, "run-root", "c1",
		map[string]string{"title": "Shared", "heading": "Root", "content": "root note"}), &created)

	var listed scratchpad.ListResult
	decodeOK(t, callTool(t, listT, ctxAsync, "run-async", "c2", map[string]any{}), &listed)
	if len(listed.Files) != 1 || listed.Files[0].FileID != created.FileID {
		t.Fatalf("async-like run did not see originator workspace: %+v", listed.Files)
	}

	decodeOK(t, callTool(t, appendT, ctxCallback, "run-callback", "c3",
		map[string]string{"file_id": created.FileID, "heading": "Callback", "content": "callback note"}), &scratchpad.WriteResult{})

	var secs scratchpad.GetSectionsResult
	decodeOK(t, callTool(t, getT, ctxAsync, "run-async", "c4",
		map[string]string{"file_id": created.FileID}), &secs)
	if len(secs.Sections) != 2 {
		t.Fatalf("shared workspace should contain root + callback sections, got %d", len(secs.Sections))
	}
}

func TestScratchpadAppendMissingFileIsError(t *testing.T) {
	svc := spService(t)
	appendT := tools.NewScratchpadAppendTool(svc)
	res := callTool(t, appendT, agentCtx("A", "orig"), "run-A", "c1",
		map[string]string{"file_id": "spfile_doesnotexist", "heading": "h", "content": "c"})
	if !res.IsError {
		t.Fatalf("append to missing file should be IsError, got %s", res.Content)
	}
}

func TestScratchpadToolRequiresRuntimeContext(t *testing.T) {
	svc := spService(t)
	createT := tools.NewScratchpadCreateTool(svc)
	raw, _ := json.Marshal(map[string]string{"title": "t", "heading": "h", "content": "c"})
	// No memory scope / delegation in ctx → structural error (not an IsError result).
	if _, err := createT.Execute(context.Background(), tools.ToolCall{ID: "c1", RunID: "r1", Args: raw}); err == nil {
		t.Fatal("expected an error when runtime context is missing")
	}
}

func TestScratchpadRegistryGating(t *testing.T) {
	names := []string{
		"scratchpad_create", "scratchpad_append_section", "scratchpad_replace_section",
		"scratchpad_list", "scratchpad_get_sections", "scratchpad_read_section", "scratchpad_search",
	}
	with := tools.NewToolRegistry(nil, nil, spService(t))
	for _, n := range names {
		if !with.Has(n) {
			t.Fatalf("registry with scratchpad svc missing %q", n)
		}
	}
	without := tools.NewToolRegistry(nil, nil, nil)
	for _, n := range names {
		if without.Has(n) {
			t.Fatalf("registry with nil scratchpad svc should not have %q", n)
		}
	}
}
