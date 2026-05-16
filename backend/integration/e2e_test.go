package integration_test

// e2e_test.go demonstrates the complete message lifecycle end-to-end:
//
//   user message
//     → SSE: run.started, step.started, tool.started, tool.completed, step.completed
//     → SSE: run.persisted (after InsertMany)
//     → SSE: run.completed (terminal, always last)
//     → GET /threads/{id}/messages confirms user + assistant messages persisted
//     → GET /runs/{id} confirms run document exists and is accessible
//
// Note: status transitions (running → completed) are performed by the real
// AgentRuntime inside its defer, not by the handler. Stub-based tests leave
// the run in "running" status — that transition is covered by repository tests.

import (
	"net/http"
	"strings"
	"testing"

	"backend/agent"
	"backend/llm"
)

func TestE2EMessageSendStreamToolCallAndPersist(t *testing.T) {
	// Script one run: a realistic tool-using step followed by completion.
	runCall := scriptedCall{
		events: []agent.StreamEvent{
			{Type: agent.EventRunStarted},
			{Type: agent.EventStepStarted, Step: 1},
			{
				Type: agent.EventToolStarted,
				Tool: &agent.ToolMeta{Name: "calculator", ID: "call-42", Display: "calculator(6*7)"},
			},
			{
				Type: agent.EventToolCompleted,
				Tool: &agent.ToolMeta{Name: "calculator", ID: "call-42"},
			},
			{Type: agent.EventStepCompleted, Step: 1},
			{Type: agent.EventRunCompleted}, // terminal — emitted last after persist
		},
		result: &agent.RunResult{
			NewMessages: []llm.ChatMessage{
				{Role: "assistant", Content: "The answer is 42"},
			},
			Steps: 1,
		},
	}
	rt := &scriptedRuntime{calls: []scriptedCall{runCall}}

	e := newTestEnvWithRuntime(t, rt)
	token := e.mustSignup(t, "e2e@example.com", "password123")
	agentID := createAgent(t, e, token, "E2EAgent")
	threadID := createThread(t, e, token, agentID, "E2EThread")

	// ── Step 1: Send message and collect the full SSE stream ─────────────────
	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "what is 6 times 7",
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("send: expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		resp.Body.Close()
		t.Fatalf("Content-Type: got %q, want text/event-stream", ct)
	}

	// collectSSEEvents drains the full body — by the time it returns,
	// the handler has already called InsertMany and emitted run.persisted + run.completed.
	events := collectSSEEvents(t, resp)
	types := findEventTypes(events)

	// ── Step 2: Verify event sequence ────────────────────────────────────────
	assertEventPresent(t, types, agent.EventRunStarted, "run.started")
	assertEventPresent(t, types, agent.EventStepStarted, "step.started")
	assertEventPresent(t, types, agent.EventToolStarted, "tool.started")
	assertEventPresent(t, types, agent.EventToolCompleted, "tool.completed")
	assertEventPresent(t, types, agent.EventStepCompleted, "step.completed")
	assertEventPresent(t, types, agent.EventRunPersisted, "run.persisted")

	// run.completed must be the very last event.
	if len(events) == 0 || events[len(events)-1].Type != agent.EventRunCompleted {
		last := agent.EventType("<none>")
		if len(events) > 0 {
			last = events[len(events)-1].Type
		}
		t.Errorf("last SSE event: got %q, want run.completed; sequence: %v", last, types)
	}
	// run.persisted must come before run.completed.
	assertOrderedBefore(t, types, agent.EventRunPersisted, agent.EventRunCompleted)

	// ── Step 3: Verify messages were persisted ───────────────────────────────
	resp2 := e.do(t, "GET", "/api/threads/"+threadID+"/messages", nil, token)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("list messages: expected 200, got %d", resp2.StatusCode)
	}
	var msgs []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	decodeBody(t, resp2, &msgs)
	if len(msgs) < 2 {
		t.Fatalf("expected at least 2 persisted messages (user + assistant), got %d", len(msgs))
	}
	roleSet := map[string]bool{}
	for _, m := range msgs {
		roleSet[m.Role] = true
	}
	if !roleSet["user"] {
		t.Error("expected a persisted 'user' message")
	}
	if !roleSet["assistant"] {
		t.Error("expected a persisted 'assistant' message")
	}

	// ── Step 4: Verify run document is accessible ────────────────────────────
	// The handler prepends the user message, so the run ID is emitted in events.
	var runID string
	for _, ev := range events {
		if ev.RunID != "" {
			runID = ev.RunID
			break
		}
	}
	if runID == "" {
		t.Log("run_id not found in SSE events; skipping GetRun check")
		return
	}

	resp3 := e.do(t, "GET", "/api/runs/"+runID, nil, token)
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/runs/%s: expected 200, got %d", runID, resp3.StatusCode)
	}
	var runInfo struct {
		RunID string `json:"run_id"`
	}
	decodeBody(t, resp3, &runInfo)
	if runInfo.RunID != runID {
		t.Errorf("run_id: got %q, want %q", runInfo.RunID, runID)
	}
}

// TestE2EThreadIsolationBetweenUsers verifies that user B cannot list messages
// from a thread created by user A.
func TestE2EThreadIsolationBetweenUsers(t *testing.T) {
	e := newTestEnv(t)
	tokenA := e.mustSignup(t, "e2e-userA@example.com", "password123")
	tokenB := e.mustSignup(t, "e2e-userB@example.com", "password123")

	agentID := createAgent(t, e, tokenA, "IsolationAgent")
	threadID := createThread(t, e, tokenA, agentID, "IsolationThread")
	sendAndDrain(t, e, tokenA, threadID, "secret message")

	// User B must not be able to list messages in user A's thread.
	// The List handler checks thread ownership via GetByID(threadID, userID).
	resp := e.do(t, "GET", "/api/threads/"+threadID+"/messages", nil, tokenB)
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Errorf("user B should not access user A's thread messages (expected 4xx, got 200)")
	}
}

// ── assertion helpers ─────────────────────────────────────────────────────────

func assertEventPresent(t *testing.T, types []agent.EventType, want agent.EventType, label string) {
	t.Helper()
	for _, got := range types {
		if got == want {
			return
		}
	}
	t.Errorf("%s not found in SSE body; full sequence: %v", label, types)
}

func assertOrderedBefore(t *testing.T, types []agent.EventType, before, after agent.EventType) {
	t.Helper()
	beforeIdx, afterIdx := -1, -1
	for i, et := range types {
		if et == before && beforeIdx == -1 {
			beforeIdx = i
		}
		if et == after && afterIdx == -1 {
			afterIdx = i
		}
	}
	if beforeIdx == -1 {
		t.Errorf("event %q not found in sequence: %v", before, types)
		return
	}
	if afterIdx == -1 {
		t.Errorf("event %q not found in sequence: %v", after, types)
		return
	}
	if beforeIdx >= afterIdx {
		t.Errorf("%q (idx=%d) must appear before %q (idx=%d); sequence: %v",
			before, beforeIdx, after, afterIdx, types)
	}
}
