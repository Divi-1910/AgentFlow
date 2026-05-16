package integration_test

import (
	"net/http"
	"testing"
)

// createAgent creates an agent and returns its ID.
func createAgent(t *testing.T, e *testEnv, token, name string) string {
	t.Helper()
	var created struct{ ID string `json:"id"` }
	resp := e.do(t, "POST", "/api/agents", minimalAgent(name), token)
	decodeBody(t, resp, &created)
	if created.ID == "" {
		t.Fatalf("createAgent %q: got empty ID (status %d)", name, resp.StatusCode)
	}
	return created.ID
}

func TestThreadCreateReturns201(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "thread-create@example.com", "password123")
	agentID := createAgent(t, e, token, "ThreadAgent")

	resp := e.do(t, "POST", "/api/agents/"+agentID+"/threads", map[string]any{"title": "My Thread"}, token)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}
	var body struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	decodeBody(t, resp, &body)
	if body.ID == "" {
		t.Fatal("expected non-empty thread ID")
	}
	if body.Title != "My Thread" {
		t.Errorf("title: got %q, want %q", body.Title, "My Thread")
	}
}

func TestThreadListByAgentReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "thread-list@example.com", "password123")
	agentID := createAgent(t, e, token, "ListAgent")

	// Create two threads.
	for _, title := range []string{"Thread A", "Thread B"} {
		resp := e.do(t, "POST", "/api/agents/"+agentID+"/threads", map[string]any{"title": title}, token)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create thread %q: expected 201, got %d", title, resp.StatusCode)
		}
	}

	resp := e.do(t, "GET", "/api/agents/"+agentID+"/threads", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var threads []struct{ ID string `json:"id"` }
	decodeBody(t, resp, &threads)
	if len(threads) != 2 {
		t.Errorf("expected 2 threads, got %d", len(threads))
	}
}

func TestThreadCreateForNonexistentAgentReturns404(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "thread-noagent@example.com", "password123")

	// Use a valid-format but nonexistent agent ID.
	resp := e.do(t, "POST", "/api/agents/507f1f77bcf86cd799439011/threads", map[string]any{"title": "orphan"}, token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestThreadListByAgentOtherUserReturns404(t *testing.T) {
	e := newTestEnv(t)
	tokenA := e.mustSignup(t, "thread-owner@example.com", "password123")
	tokenB := e.mustSignup(t, "thread-intruder@example.com", "password123")

	agentID := createAgent(t, e, tokenA, "PrivateAgent")

	// User B cannot list threads for an agent they don't own (agent lookup fails first).
	resp := e.do(t, "GET", "/api/agents/"+agentID+"/threads", nil, tokenB)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}
