package integration_test

// stream_accept_test.go verifies the SSE event contract for the message-send
// endpoint:
//   - Non-terminal events (run.started, step.*, tool.*) appear in the body.
//   - run.persisted appears before run.completed.
//   - run.completed is always the last event (emitted after persist, never inside the loop).

import (
	"bufio"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"
)

// collectSSEEvents reads the SSE body line by line and returns the ordered
// slice of parsed StreamEvent objects (one per "data:" line).
func collectSSEEvents(t *testing.T, resp *http.Response) []agent.StreamEvent {
	t.Helper()
	defer resp.Body.Close()

	var events []agent.StreamEvent
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		var e agent.StreamEvent
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			t.Logf("collectSSEEvents: failed to parse %q: %v", raw, err)
			continue
		}
		events = append(events, e)
	}
	return events
}

// findEventTypes returns the ordered list of event types from a slice.
func findEventTypes(events []agent.StreamEvent) []agent.EventType {
	types := make([]agent.EventType, len(events))
	for i, e := range events {
		types[i] = e.Type
	}
	return types
}

// TestStreamRunStartedAppearsInBody verifies that the non-terminal run.started
// event is written directly to the SSE body (not held for post-loop emit).
func TestStreamRunStartedAppearsInBody(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "stream-started@example.com", "password123")
	agentID := createAgent(t, e, token, "StreamAgent")
	threadID := createThread(t, e, token, agentID, "StreamThread")

	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "hello",
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	events := collectSSEEvents(t, resp)
	if len(events) == 0 {
		t.Fatal("expected at least one SSE event")
	}

	var sawRunStarted bool
	for _, ev := range events {
		if ev.Type == agent.EventRunStarted {
			sawRunStarted = true
			break
		}
	}
	if !sawRunStarted {
		t.Errorf("run.started not found in SSE body; got event types: %v", findEventTypes(events))
	}
}

// TestStreamRunCompletedIsLastEvent verifies that run.completed is the final
// event in the SSE body — emitted after run.persisted, never inside the loop.
func TestStreamRunCompletedIsLastEvent(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "stream-last@example.com", "password123")
	agentID := createAgent(t, e, token, "LastEventAgent")
	threadID := createThread(t, e, token, agentID, "LastEventThread")

	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "ping",
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	events := collectSSEEvents(t, resp)
	if len(events) == 0 {
		t.Fatal("expected at least one SSE event")
	}

	last := events[len(events)-1]
	if last.Type != agent.EventRunCompleted {
		t.Errorf("last event: got %q, want %q; full sequence: %v",
			last.Type, agent.EventRunCompleted, findEventTypes(events))
	}
}

// TestStreamRunPersistedBeforeCompleted verifies the post-loop ordering:
// run.persisted must appear before run.completed.
func TestStreamRunPersistedBeforeCompleted(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "stream-persist@example.com", "password123")
	agentID := createAgent(t, e, token, "PersistOrderAgent")
	threadID := createThread(t, e, token, agentID, "PersistOrderThread")

	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "test persist order",
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	events := collectSSEEvents(t, resp)

	var persistIdx, completedIdx int = -1, -1
	for i, ev := range events {
		switch ev.Type {
		case agent.EventRunPersisted:
			persistIdx = i
		case agent.EventRunCompleted:
			completedIdx = i
		}
	}

	if persistIdx == -1 {
		t.Fatalf("run.persisted not found in SSE body; sequence: %v", findEventTypes(events))
	}
	if completedIdx == -1 {
		t.Fatalf("run.completed not found in SSE body; sequence: %v", findEventTypes(events))
	}
	if persistIdx >= completedIdx {
		t.Errorf("run.persisted (idx=%d) must appear before run.completed (idx=%d); sequence: %v",
			persistIdx, completedIdx, findEventTypes(events))
	}
}

// TestStreamToolEventsAppearInBody uses a scriptedRuntime that emits a full
// step+tool sequence and verifies each event type appears in the SSE body.
func TestStreamToolEventsAppearInBody(t *testing.T) {
	toolEvents := []agent.StreamEvent{
		{Type: agent.EventRunStarted},
		{Type: agent.EventStepStarted, Step: 1},
		{Type: agent.EventToolStarted, Tool: &agent.ToolMeta{Name: "calculator", ID: "call-1"}},
		{Type: agent.EventToolCompleted, Tool: &agent.ToolMeta{Name: "calculator", ID: "call-1"}},
		{Type: agent.EventStepCompleted, Step: 1},
		{Type: agent.EventRunCompleted}, // terminal — will be last after persist
	}
	call := scriptedCall{
		events: toolEvents,
		result: &agent.RunResult{
			NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "42"}},
			Steps:       1,
		},
	}
	rt := &scriptedRuntime{calls: []scriptedCall{call}}

	e := newTestEnvWithRuntime(t, rt)
	token := e.mustSignup(t, "stream-tool@example.com", "password123")
	agentID := createAgent(t, e, token, "ToolAgent")
	threadID := createThread(t, e, token, agentID, "ToolThread")

	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "what is 6 times 7",
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	events := collectSSEEvents(t, resp)
	types := findEventTypes(events)

	wantInBody := []agent.EventType{
		agent.EventRunStarted,
		agent.EventStepStarted,
		agent.EventToolStarted,
		agent.EventToolCompleted,
		agent.EventStepCompleted,
	}
	for _, want := range wantInBody {
		var found bool
		for _, got := range types {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("event %q not found in SSE body; full sequence: %v", want, types)
		}
	}

	// run.completed must be the last event.
	if len(events) > 0 && events[len(events)-1].Type != agent.EventRunCompleted {
		t.Errorf("last event: got %q, want run.completed; full sequence: %v",
			events[len(events)-1].Type, types)
	}
}

// TestStreamStepStartedBeforeStepCompleted checks that within a step sequence,
// step.started precedes step.completed in the SSE body.
func TestStreamStepStartedBeforeStepCompleted(t *testing.T) {
	call := scriptedCall{
		events: []agent.StreamEvent{
			{Type: agent.EventRunStarted},
			{Type: agent.EventStepStarted, Step: 1, Time: time.Now()},
			{Type: agent.EventStepCompleted, Step: 1, Time: time.Now()},
			{Type: agent.EventRunCompleted},
		},
		result: &agent.RunResult{
			NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "done"}},
			Steps:       1,
		},
	}
	rt := &scriptedRuntime{calls: []scriptedCall{call}}

	e := newTestEnvWithRuntime(t, rt)
	token := e.mustSignup(t, "stream-step@example.com", "password123")
	agentID := createAgent(t, e, token, "StepAgent")
	threadID := createThread(t, e, token, agentID, "StepThread")

	resp := e.do(t, "POST", "/api/threads/"+threadID+"/messages", map[string]any{
		"content": "go",
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	events := collectSSEEvents(t, resp)
	var startedIdx, completedIdx int = -1, -1
	for i, ev := range events {
		switch ev.Type {
		case agent.EventStepStarted:
			startedIdx = i
		case agent.EventStepCompleted:
			completedIdx = i
		}
	}

	if startedIdx == -1 || completedIdx == -1 {
		t.Fatalf("missing step events; sequence: %v", findEventTypes(events))
	}
	if startedIdx >= completedIdx {
		t.Errorf("step.started (idx=%d) must precede step.completed (idx=%d)", startedIdx, completedIdx)
	}
}
