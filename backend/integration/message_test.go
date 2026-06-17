package integration_test

import (
	"bufio"
	"net/http"
	"strings"
	"testing"
)

// createThread creates a thread and returns its ID.
func createThread(t *testing.T, e *testEnv, token, agentID, title string) string {
	t.Helper()
	var created struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents/"+agentID+"/threads", map[string]any{"title": title}, token)
	decodeBody(t, resp, &created)
	if created.ID == "" {
		t.Fatalf("createThread %q: got empty ID (status %d)", title, resp.StatusCode)
	}
	return created.ID
}

func TestMessageListEmptyThreadReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "msg-empty@example.com", "password123")
	agentID := createAgent(t, e, token, "MsgAgent")
	threadID := createThread(t, e, token, agentID, "Empty Thread")

	resp := e.do(t, "GET", "/api/threads/"+threadID+"/messages", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var messages []any
	decodeBody(t, resp, &messages)
	if len(messages) != 0 {
		t.Errorf("expected 0 messages, got %d", len(messages))
	}
}

func TestMessageSendReturnsSSEStream(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "msg-send@example.com", "password123")
	agentID := createAgent(t, e, token, "StreamAgent")
	threadID := createThread(t, e, token, agentID, "SSE Thread")

	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "hello",
	}, token)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 (SSE), got %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type: got %q, want text/event-stream", ct)
	}

	// Read lines and verify at least one SSE event is present.
	var sawEvent bool
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			sawEvent = true
			break
		}
	}
	if !sawEvent {
		t.Error("expected at least one SSE data line")
	}
}

func TestMessageSendThenListShowsMessages(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "msg-list@example.com", "password123")
	agentID := createAgent(t, e, token, "PersistAgent")
	threadID := createThread(t, e, token, agentID, "Persist Thread")

	// Send a message (SSE); drain body fully so persistence completes.
	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "what is 2+2",
	}, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("send: expected 200, got %d", resp.StatusCode)
	}
	// Drain the SSE body so the server finishes persisting.
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
	}
	resp.Body.Close()

	// Now list messages — should include the user message and the stub assistant reply.
	resp2 := e.do(t, "GET", "/api/threads/"+threadID+"/messages", nil, token)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", resp2.StatusCode)
	}
	var messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	decodeBody(t, resp2, &messages)
	if len(messages) < 2 {
		t.Fatalf("expected at least 2 messages (user + assistant), got %d", len(messages))
	}
	// User and assistant messages are inserted in a single InsertMany call so they share
	// the same millisecond timestamp; sort order is non-deterministic. Check presence only.
	roleSet := map[string]bool{}
	for _, m := range messages {
		roleSet[m.Role] = true
	}
	if !roleSet["user"] {
		t.Error("expected a 'user' message in the list")
	}
	if !roleSet["assistant"] {
		t.Error("expected an 'assistant' message in the list")
	}
}
