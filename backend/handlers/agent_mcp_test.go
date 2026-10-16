package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
	"backend/mcp"
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
			{"server_id": "fetch"},
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
	if got.ServerID != "fetch" {
		t.Fatalf("captured config = %+v", got)
	}
	var resp handlers.AgentResponse
	decodeJSON(t, rec.Body.Bytes(), &resp)
	if len(resp.MCPServers) != 1 || resp.MCPServers[0].ServerID != "fetch" {
		t.Fatalf("response MCPServers = %+v", resp.MCPServers)
	}
}

func TestAgentHandlerResponseExposesOnlyServerID(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		return &agent.Agent{ID: id, Name: "a", MCPServers: []agent.MCPServerSelection{
			{ServerID: "fetch"},
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
	// URL, alias, and all credential concepts remain catalog-owned.
	var raw map[string]json.RawMessage
	decodeJSON(t, rec.Body.Bytes(), &raw)
	var servers []map[string]any
	decodeJSON(t, raw["mcp_servers"], &servers)
	if len(servers) != 1 {
		t.Fatalf("mcp_servers = %v", servers)
	}
	for k := range servers[0] {
		if k != "server_id" {
			t.Fatalf("unexpected key %q in mcp_servers entry: %v", k, servers[0])
		}
	}
	if servers[0]["server_id"] != "fetch" {
		t.Fatalf("server_id = %v", servers[0]["server_id"])
	}
}

func TestAgentHandlerCreateRejectsBadMCPServers(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		servers []map[string]string
	}{
		{"bad server id", []map[string]string{{"server_id": "has space"}}},
		{"empty server id", []map[string]string{{"server_id": ""}}},
		{"duplicate server id", []map[string]string{{"server_id": "fetch"}, {"server_id": "fetch"}}},
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

func TestAgentHandlerCreateRejectsLegacyMCPFields(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	body := []byte(`{
		"name":"a","provider":"openai","model":"gpt-4","system_prompt":"x",
		"mcp_servers":[{"server_id":"fetch","url":"https://legacy.example/mcp","bearer_env":"LEGACY_TOKEN"}]
	}`)
	recorder := httptest.NewRecorder()
	h.Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/agents", bytes.NewReader(body))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentHandlerCreateRejectsUnknownOrDisabledMCPServer(t *testing.T) {
	t.Parallel()
	h := newAgentHandlerWithCatalog(&fakeAgentStore{}, fakeMCPServerLookup{entries: map[string]mcp.CatalogEntry{}})
	body, _ := json.Marshal(map[string]any{
		"name": "a", "provider": "openai", "model": "gpt-4", "system_prompt": "x",
		"mcp_servers": []map[string]string{{"server_id": "fetch"}},
	})
	rec := httptest.NewRecorder()
	h.Create(rec, withUser(httptest.NewRequest(http.MethodPost, "/agents", bytes.NewBuffer(body))))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestAgentHandlerCreateReturnsInternalErrorWhenMCPCatalogFails(t *testing.T) {
	t.Parallel()
	h := newAgentHandlerWithCatalog(&fakeAgentStore{}, fakeMCPServerLookup{err: errors.New("database unavailable")})
	body, _ := json.Marshal(map[string]any{
		"name": "a", "provider": "openai", "model": "gpt-4", "system_prompt": "x",
		"mcp_servers": []map[string]string{{"server_id": "fetch"}},
	})
	rec := httptest.NewRecorder()
	h.Create(rec, withUser(httptest.NewRequest(http.MethodPost, "/agents", bytes.NewBuffer(body))))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}
