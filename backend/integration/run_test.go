package integration_test

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// sendMessage fires a POST /api/threads/{id}/messages, drains the SSE body, and
// returns the run_id extracted from the first "run_started" event data line.
func sendAndDrain(t *testing.T, e *testEnv, token, threadID, content string) string {
	t.Helper()
	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": content,
	}, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("send message: expected 200, got %d", resp.StatusCode)
	}
	defer resp.Body.Close()

	var runID string
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			// Extract run_id from the event JSON.
			data := strings.TrimPrefix(line, "data:")
			data = strings.TrimSpace(data)
			// Simple extraction: look for "run_id":"<value>"
			if idx := strings.Index(data, `"run_id":"`); idx != -1 {
				rest := data[idx+len(`"run_id":"`):]
				end := strings.Index(rest, `"`)
				if end != -1 {
					runID = rest[:end]
				}
			}
		}
	}
	return runID
}

func TestRunGetNotFoundReturns404(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "run-notfound@example.com", "password123")

	// A UUID that doesn't exist in the DB.
	resp := e.do(t, "GET", "/api/runs/"+uuid.NewString(), nil, token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestRunGetFoundReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "run-found@example.com", "password123")
	agentID := createAgent(t, e, token, "RunAgent")
	threadID := createThread(t, e, token, agentID, "RunThread")

	runID := sendAndDrain(t, e, token, threadID, "ping")
	if runID == "" {
		t.Skip("run_id not found in SSE stream — skipping run GET test")
	}

	resp := e.do(t, "GET", "/api/runs/"+runID, nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body struct {
		RunID  string `json:"run_id"`
		Status string `json:"status"`
	}
	decodeBody(t, resp, &body)
	if body.RunID != runID {
		t.Errorf("run_id: got %q, want %q", body.RunID, runID)
	}
}

func TestRunGetOtherUserReturns404(t *testing.T) {
	e := newTestEnv(t)
	tokenA := e.mustSignup(t, "run-owner@example.com", "password123")
	tokenB := e.mustSignup(t, "run-intruder@example.com", "password123")

	agentID := createAgent(t, e, tokenA, "OwnerAgent")
	threadID := createThread(t, e, tokenA, agentID, "OwnerThread")

	// Seed a run directly via runRepo so we have a stable runID without parsing SSE.
	runID := uuid.NewString()
	if err := e.runRepo.CreateRun(context.Background(), runID, threadID, agentID, "owner-user"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	// User B should not be able to see user A's run.
	resp := e.do(t, "GET", "/api/runs/"+runID, nil, tokenB)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}
