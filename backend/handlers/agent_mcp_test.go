package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
)

func TestAgentHandlerCreateRoundTripsMCPServers(t *testing.T) {
	t.Parallel()
	var captured *agent.Agent
	store := &fakeAgentStore{createFn: func(_ context.Context, _ string, a *agent.Agent) (*agent.Agent, error) {
		captured = a
		a.ID = testAgentID
		a.CreatedAt = time.Now()
		return a, nil
	}}
	h := newAgentHandler(store)

	body, _ := json.Marshal(map[string]any{
		"name": "a", "provider": "openai", "model": "gpt-4", "system_prompt": "x",
		"mcp_servers": []map[string]string{
			{"alias": "jira", "url": "https://mcp.example.com/jira", "bearer_env": "JIRA_TOKEN"},
		},
	})
	rec := httptest.NewRecorder()
	h.Create(rec, withUser(httptest.NewRequest(http.MethodPost, "/agents", bytes.NewBuffer(body))))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if captured == nil || len(captured.MCPServers) != 1 {
		t.Fatalf("captured MCPServers = %+v", captured)
	}
	got := captured.MCPServers[0]
	if got.Alias != "jira" || got.URL != "https://mcp.example.com/jira" || got.BearerEnv != "JIRA_TOKEN" {
		t.Fatalf("captured config = %+v", got)
	}
	var resp handlers.AgentResponse
	decodeJSON(t, rec.Body.Bytes(), &resp)
	if len(resp.MCPServers) != 1 || resp.MCPServers[0].Alias != "jira" || resp.MCPServers[0].BearerEnv != "JIRA_TOKEN" {
		t.Fatalf("response MCPServers = %+v", resp.MCPServers)
	}
}

// The API surfaces only the env-var NAME (bearer_env); it must never carry a
// resolved token value.
func TestAgentHandlerResponseNeverLeaksToken(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		return &agent.Agent{ID: id, Name: "a", MCPServers: []agent.MCPServerConfig{
			{Alias: "jira", URL: "https://mcp.example.com/jira", BearerEnv: "SECRET_ENV"},
		}}, nil
	}}
	h := newAgentHandler(store)

	req := withUser(httptest.NewRequest(http.MethodGet, "/agents/"+testAgentID, nil))
	req.SetPathValue("id", testAgentID)
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Each mcp_servers entry must expose ONLY alias/url/bearer_env — never a
	// resolved token under any key. (A substring check would false-match
	// "max_tokens", so assert on the actual key set.)
	var raw map[string]json.RawMessage
	decodeJSON(t, rec.Body.Bytes(), &raw)
	var servers []map[string]any
	decodeJSON(t, raw["mcp_servers"], &servers)
	if len(servers) != 1 {
		t.Fatalf("mcp_servers = %v", servers)
	}
	for k := range servers[0] {
		if k != "alias" && k != "url" && k != "bearer_env" {
			t.Fatalf("unexpected key %q in mcp_servers entry — possible secret leak: %v", k, servers[0])
		}
	}
	if servers[0]["bearer_env"] != "SECRET_ENV" {
		t.Fatalf("bearer_env = %v", servers[0]["bearer_env"])
	}
}

func TestAgentHandlerCreateRejectsBadMCPServers(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		servers []map[string]string
	}{
		{"bad alias", []map[string]string{{"alias": "has space", "url": "https://x"}}},
		{"empty url", []map[string]string{{"alias": "ok", "url": ""}}},
		{"duplicate alias", []map[string]string{{"alias": "dup", "url": "https://a"}, {"alias": "dup", "url": "https://b"}}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newAgentHandler(&fakeAgentStore{})
			body, _ := json.Marshal(map[string]any{
				"name": "a", "provider": "openai", "model": "gpt-4", "system_prompt": "x",
				"mcp_servers": tc.servers,
			})
			rec := httptest.NewRecorder()
			h.Create(rec, withUser(httptest.NewRequest(http.MethodPost, "/agents", bytes.NewBuffer(body))))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d (want 400), body = %s", rec.Code, rec.Body.String())
			}
		})
	}
}
