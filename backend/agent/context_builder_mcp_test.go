package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"backend/llm"
)

func TestMCPStatusNoteRendersAndOmits(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("Agent system prompt.")

	rc := buildRunCtx("hi")
	rc.MCPUnavailable = []string{"jira"}
	out, err := cb.BuildSystemContent(context.Background(), ag, rc, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "<mcp_status>") || !strings.Contains(out, "jira") {
		t.Fatalf("expected an mcp_status note naming jira:\n%s", out)
	}

	out, err = cb.BuildSystemContent(context.Background(), ag, buildRunCtx("hi"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "<mcp_status>") {
		t.Fatal("no mcp_status note expected when all servers are healthy")
	}
}

// Contract f: the dynamic mcp_status note must not perturb the cached static
// prefix, and MCP tool defs (empty Instructions) add nothing to it either.
func TestMCPDoesNotChangeStaticPrefix(t *testing.T) {
	t.Parallel()
	cb := buildBuilder(t, &fakeMetaStore{})
	ag := buildAgent("Agent system prompt.", "calculator")

	// (a) the unavailable note is dynamic-suffix only.
	rcUp := buildRunCtx("hi")
	rcDown := buildRunCtx("hi")
	rcDown.MCPUnavailable = []string{"jira"}
	up, err := cb.BuildSystemContent(context.Background(), ag, rcUp, defsFor(ag))
	if err != nil {
		t.Fatal(err)
	}
	down, err := cb.BuildSystemContent(context.Background(), ag, rcDown, defsFor(ag))
	if err != nil {
		t.Fatal(err)
	}
	if prefixUpToContext(up) != prefixUpToContext(down) {
		t.Errorf("static prefix changed when mcp_status note added.\nUP:\n%s\nDOWN:\n%s",
			prefixUpToContext(up), prefixUpToContext(down))
	}
	if !strings.Contains(down, "<mcp_status>") {
		t.Fatal("expected mcp_status in the down variant")
	}

	// (b) an MCP tool def (empty Instructions) contributes nothing to the prefix.
	base := defsFor(ag)
	withMCP := append([]llm.ToolDefinition{}, base...)
	withMCP = append(withMCP, llm.ToolDefinition{
		Name: "mcp__demo__echo", Description: "d", Parameters: json.RawMessage(`{"type":"object"}`), Instructions: "",
	})
	baseOut, err := cb.BuildSystemContent(context.Background(), ag, buildRunCtx("hi"), base)
	if err != nil {
		t.Fatal(err)
	}
	mcpOut, err := cb.BuildSystemContent(context.Background(), ag, buildRunCtx("hi"), withMCP)
	if err != nil {
		t.Fatal(err)
	}
	if prefixUpToContext(baseOut) != prefixUpToContext(mcpOut) {
		t.Errorf("static prefix changed when an MCP tool def was added.\nBASE:\n%s\nMCP:\n%s",
			prefixUpToContext(baseOut), prefixUpToContext(mcpOut))
	}
}
