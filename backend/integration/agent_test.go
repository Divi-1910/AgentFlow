package integration_test

import (
	"net/http"
	"testing"
)

// minimalAgent is a valid CreateAgentRequest payload.
func minimalAgent(name string) map[string]any {
	return map[string]any{
		"name":          name,
		"provider":      "openai",
		"model":         "gpt-4o",
		"system_prompt": "You are a helpful assistant.",
	}
}

func TestAgentCreateReturns201(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-create@example.com", "password123")

	resp := e.do(t, "POST", "/api/agents", minimalAgent("My Agent"), token)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}
	var body struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	decodeBody(t, resp, &body)
	if body.ID == "" {
		t.Fatal("expected non-empty agent ID")
	}
	if body.Name != "My Agent" {
		t.Errorf("name: got %q, want %q", body.Name, "My Agent")
	}
}

func TestAgentListReturnsCreatedAgents(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-list@example.com", "password123")

	// Create two agents.
	for _, name := range []string{"Alpha", "Beta"} {
		resp := e.do(t, "POST", "/api/agents", minimalAgent(name), token)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create %s: expected 201, got %d", name, resp.StatusCode)
		}
	}

	resp := e.do(t, "GET", "/api/agents", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var agents []struct {
		ID string `json:"id"`
	}
	decodeBody(t, resp, &agents)
	if len(agents) != 2 {
		t.Errorf("expected 2 agents, got %d", len(agents))
	}
}

func TestAgentGetReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-get@example.com", "password123")

	// Create agent.
	var created struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents", minimalAgent("Getter"), token)
	decodeBody(t, resp, &created)

	resp2 := e.do(t, "GET", "/api/agents/"+created.ID, nil, token)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp2.StatusCode)
	}
	var body struct {
		Name string `json:"name"`
	}
	decodeBody(t, resp2, &body)
	if body.Name != "Getter" {
		t.Errorf("name: got %q, want %q", body.Name, "Getter")
	}
}

func TestAgentGetOtherUserReturns404(t *testing.T) {
	e := newTestEnv(t)
	tokenA := e.mustSignup(t, "agent-owner@example.com", "password123")
	tokenB := e.mustSignup(t, "agent-other@example.com", "password123")

	var created struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents", minimalAgent("Private"), tokenA)
	decodeBody(t, resp, &created)

	resp2 := e.do(t, "GET", "/api/agents/"+created.ID, nil, tokenB)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp2.StatusCode)
	}
}

func TestAgentUpdateReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-update@example.com", "password123")

	var created struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents", minimalAgent("OldName"), token)
	decodeBody(t, resp, &created)

	newName := "NewName"
	resp2 := e.do(t, "PUT", "/api/agents/"+created.ID, map[string]any{"name": &newName}, token)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp2.StatusCode)
	}
	var body struct {
		Name string `json:"name"`
	}
	decodeBody(t, resp2, &body)
	if body.Name != "NewName" {
		t.Errorf("name: got %q, want %q", body.Name, "NewName")
	}
}

func TestAgentDeleteReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-delete@example.com", "password123")

	var created struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents", minimalAgent("Doomed"), token)
	decodeBody(t, resp, &created)

	resp2 := e.do(t, "DELETE", "/api/agents/"+created.ID, nil, token)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp2.StatusCode)
	}

	// Confirm it's gone.
	resp3 := e.do(t, "GET", "/api/agents/"+created.ID, nil, token)
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", resp3.StatusCode)
	}
}
