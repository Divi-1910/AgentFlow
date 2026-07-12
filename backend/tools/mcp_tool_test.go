package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"backend/mcp"
)

// mcpEcho is a minimal MCP server: initialize, notifications/initialized,
// tools/list (one tool), tools/call (echoes / errors per the request).
func mcpEchoServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s1")
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18"}}`, req.ID)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"d","inputSchema":{"type":"object"}}]}}`, req.ID)
		case "tools/call":
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}`, req.ID)
		}
	}))
}

func permissiveManager(srv *httptest.Server) *MCPManager {
	m := NewMCPManager(srv.Client())
	m.validate = func(string) error { return nil } // bypass https/SSRF for httptest (http+loopback)
	return m
}

func TestMCPDiscoverHappyPath(t *testing.T) {
	srv := mcpEchoServer(t)
	defer srv.Close()

	toolset, unavailable := permissiveManager(srv).Discover(context.Background(),
		[]MCPServerSpec{{Alias: "demo", URL: srv.URL}})
	if len(unavailable) != 0 {
		t.Fatalf("unavailable = %v", unavailable)
	}
	if len(toolset) != 1 {
		t.Fatalf("want 1 tool, got %d", len(toolset))
	}
	if toolset[0].Name() != "mcp__demo__echo" {
		t.Fatalf("tool name = %q", toolset[0].Name())
	}
	if got := string(toolset[0].Definition().Parameters); !strings.Contains(got, "object") {
		t.Fatalf("definition params = %q", got)
	}
}

func TestValidateMCPServerURLSyntax(t *testing.T) {
	valid := []string{
		"https://example.com/mcp",
		"https://example.com:8443/mcp?tenant=a",
	}
	for _, raw := range valid {
		if err := ValidateMCPServerURLSyntax(raw); err != nil {
			t.Errorf("ValidateMCPServerURLSyntax(%q): %v", raw, err)
		}
	}
	invalid := []string{
		"http://example.com/mcp",
		"/relative/mcp",
		"https:///missing-host",
		"https://token@example.com/mcp",
	}
	for _, raw := range invalid {
		if err := ValidateMCPServerURLSyntax(raw); err == nil {
			t.Errorf("ValidateMCPServerURLSyntax(%q) succeeded", raw)
		}
	}
}

func TestMCPDiscoverDegradesOnUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	toolset, unavailable := permissiveManager(srv).Discover(context.Background(),
		[]MCPServerSpec{{Alias: "down", URL: srv.URL}})
	if len(toolset) != 0 {
		t.Fatalf("want 0 tools, got %d", len(toolset))
	}
	if len(unavailable) != 1 || unavailable[0] != "down" {
		t.Fatalf("unavailable = %v (want [down])", unavailable)
	}
}

// Discover flattens tools in config order regardless of goroutine completion.
func TestMCPDiscoverDeterministicOrder(t *testing.T) {
	a := mcpEchoServer(t)
	defer a.Close()
	b := mcpEchoServer(t)
	defer b.Close()

	m := NewMCPManager(http.DefaultClient)
	m.validate = func(string) error { return nil }
	toolset, _ := m.Discover(context.Background(), []MCPServerSpec{
		{Alias: "aaa", URL: a.URL},
		{Alias: "bbb", URL: b.URL},
	})
	if len(toolset) != 2 || toolset[0].Name() != "mcp__aaa__echo" || toolset[1].Name() != "mcp__bbb__echo" {
		var names []string
		for _, x := range toolset {
			names = append(names, x.Name())
		}
		t.Fatalf("tools not in config order: %v", names)
	}
}

func TestMCPManagerValidateRejectsHTTPAndLoopback(t *testing.T) {
	m := NewMCPManager(http.DefaultClient) // real validator
	if err := m.validate("http://example.com/mcp"); err == nil {
		t.Error("expected https-only rejection for http URL")
	}
	if err := m.validate("https://localhost/mcp"); err == nil {
		t.Error("expected localhost rejection")
	}
}

func newEchoMCPTool(t *testing.T, srv *httptest.Server) *MCPTool {
	t.Helper()
	return newMCPTool(mcp.NewClient(srv.Client(), srv.URL, ""), "demo", mcp.ToolSpec{Name: "echo"})
}

func TestMCPToolExecuteSuccess(t *testing.T) {
	srv := mcpEchoServer(t)
	defer srv.Close()
	res, err := newEchoMCPTool(t, srv).Execute(context.Background(), ToolCall{ID: "c1", Args: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res == nil || res.IsError || res.Content != "ok" {
		t.Fatalf("res = %+v", res)
	}
}

func TestMCPToolExecuteToolError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"bad"}],"isError":true}}`, req.ID)
	}))
	defer srv.Close()
	res, err := newEchoMCPTool(t, srv).Execute(context.Background(), ToolCall{ID: "c1"})
	if err != nil {
		t.Fatalf("tool-level error must not be a Go error: %v", err)
	}
	if res == nil || !res.IsError || res.Content != "bad" {
		t.Fatalf("res = %+v", res)
	}
}

func TestMCPToolExecuteTransportErrorIsSoft(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	res, err := newEchoMCPTool(t, srv).Execute(context.Background(), ToolCall{ID: "c1"})
	if err != nil {
		t.Fatalf("transport failure must be soft (nil err): %v", err)
	}
	if res == nil { // never (nil,nil) — tool_batch treats nil result as a hard failure
		t.Fatal("result must be non-nil")
	}
	if !res.IsError {
		t.Fatalf("transport failure must set IsError; res = %+v", res)
	}
}

func TestMCPToolDefinitionSchemaFallback(t *testing.T) {
	cli := mcp.NewClient(http.DefaultClient, "https://x", "")
	// empty / null / whitespace / oversized / non-object → {"type":"object"}
	fallbackCases := []mcp.ToolSpec{
		{Name: "a", InputSchema: nil},
		{Name: "b", InputSchema: json.RawMessage("null")},
		{Name: "c", InputSchema: json.RawMessage("   ")},
		{Name: "d", InputSchema: json.RawMessage(`{"` + strings.Repeat("x", mcpMaxSchemaBytes) + `":1}`)},
		{Name: "e", InputSchema: json.RawMessage(`[1,2,3]`)},           // array value
		{Name: "f", InputSchema: json.RawMessage(`"hello"`)},           // scalar value
		{Name: "g", InputSchema: json.RawMessage(`not json`)},          // invalid
		{Name: "i", InputSchema: json.RawMessage(`{"type":"array"}`)},  // wrong schema type
		{Name: "j", InputSchema: json.RawMessage(`{"type":"string"}`)}, // wrong schema type
	}
	for _, sp := range fallbackCases {
		def := newMCPTool(cli, "demo", sp).Definition()
		if string(def.Parameters) != `{"type":"object"}` {
			t.Fatalf("spec %q: params = %q (want object fallback)", sp.Name, def.Parameters)
		}
	}
	// Object missing "type" → "type":"object" is inserted, properties preserved.
	def := newMCPTool(cli, "demo", mcp.ToolSpec{Name: "h", InputSchema: json.RawMessage(`{"properties":{"x":{"type":"string"}}}`)}).Definition()
	if !strings.Contains(string(def.Parameters), `"type":"object"`) || !strings.Contains(string(def.Parameters), "properties") {
		t.Fatalf("missing-type object not normalized: %q", def.Parameters)
	}
	// A well-formed typed object is passed through verbatim.
	def = newMCPTool(cli, "demo", mcp.ToolSpec{Name: "ok", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)}).Definition()
	if !strings.Contains(string(def.Parameters), "properties") {
		t.Fatalf("valid schema not passed through: %q", def.Parameters)
	}
}

// Remote tools whose namespaced name would be provider-invalid (bad chars) or
// too long are skipped during discovery.
func TestMCPDiscoverSkipsInvalidToolNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18"}}`, req.ID)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			// "good" is valid; "bad.name" has a dot; the long one blows the 64-char cap.
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[
				{"name":"good"},{"name":"bad.name"},{"name":"%s"}
			]}}`, req.ID, strings.Repeat("z", 70))
		}
	}))
	defer srv.Close()

	toolset, unavailable := permissiveManager(srv).Discover(context.Background(),
		[]MCPServerSpec{{Alias: "demo", URL: srv.URL}})
	if len(unavailable) != 0 {
		t.Fatalf("unavailable = %v", unavailable)
	}
	if len(toolset) != 1 || toolset[0].Name() != "mcp__demo__good" {
		var names []string
		for _, x := range toolset {
			names = append(names, x.Name())
		}
		t.Fatalf("expected only mcp__demo__good, got %v", names)
	}
}
