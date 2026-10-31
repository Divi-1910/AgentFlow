package integration_test

import (
	"net/http"
	"testing"

	"backend/handlers"
)

func TestProductCatalogRoutes(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "catalog-routes@example.com", "password123")

	resp := e.do(t, "GET", "/api/tools", nil, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("tools: expected 200, got %d", resp.StatusCode)
	}
	var tools []handlers.ToolResponse
	decodeBody(t, resp, &tools)
	if len(tools) == 0 {
		t.Fatal("tools: expected catalog entries")
	}
	for _, entry := range tools {
		if entry.Available {
			t.Fatalf("tools: empty executable registry reported %q available", entry.Name)
		}
	}

	resp = e.do(t, "GET", "/api/mcp-servers", nil, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("MCP servers: expected 200, got %d", resp.StatusCode)
	}
	var servers []handlers.MCPServerResponse
	decodeBody(t, resp, &servers)
	if servers == nil || len(servers) != 0 {
		t.Fatalf("MCP servers: expected non-nil empty catalog, got %+v", servers)
	}

	resp = e.do(t, "GET", "/api/tools", nil, "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated tools: expected 401, got %d", resp.StatusCode)
	}
}
