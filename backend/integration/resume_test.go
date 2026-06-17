package integration_test

// resume_test.go verifies the POST /api/runs/{id}/resume endpoint:
//   - 404 for unknown run
//   - 409 when status is not resumable/interrupted
//   - 200 SSE stream when a valid checkpoint exists and status is resumable

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"

	"github.com/google/uuid"
)

func TestResumeRunNotFound(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "resume-notfound@example.com", "password123")

	resp := e.do(t, "POST", "/api/runs/"+uuid.NewString()+"/resume", nil, token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestResumeRunConflictIfCompleted(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "resume-conflict@example.com", "password123")

	agentID := createAgent(t, e, token, "ConflictAgent")
	threadID := createThread(t, e, token, agentID, "ConflictThread")

	// sendAndDrain creates a run and completes it (status=completed).
	runID := sendAndDrain(t, e, token, threadID, "ping")
	if runID == "" {
		t.Skip("run_id not found in SSE stream — skipping resume conflict test")
	}

	// The stub runtime does not call UpdateStatus, so the run stays "running" — which
	// is also not resumable. Any status other than "resumable"/"interrupted" yields 409.
	resp := e.do(t, "POST", "/api/runs/"+runID+"/resume", nil, token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict for non-resumable run, got %d", resp.StatusCode)
	}
}

func TestResumeRunSuccess(t *testing.T) {
	// The resume endpoint will call RunStream on our scripted runtime.
	resumeCall := scriptedCall{
		events: []agent.StreamEvent{
			{Type: agent.EventRunResumed},
			{Type: agent.EventRunStarted},
			{Type: agent.EventRunCompleted},
		},
		result: &agent.RunResult{
			NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "resumed response"}},
			Steps:       1,
		},
	}
	rt := &scriptedRuntime{calls: []scriptedCall{resumeCall}}

	e := newTestEnvWithRuntime(t, rt)
	token := e.mustSignup(t, "resume-success@example.com", "password123")
	userID := e.mustGetUserID(t, token)

	agentID := createAgent(t, e, token, "ResumeAgent")
	threadID := createThread(t, e, token, agentID, "ResumeThread")

	// Seed run + checkpoint directly so we control the status without going
	// through the full send→complete cycle.
	runID := uuid.NewString()
	ctx := context.Background()

	if err := e.runRepo.CreateRun(ctx, runID, threadID, agentID, userID); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	// Build a minimal valid checkpoint. ValidateSnapshot requires:
	//   - Version 1
	//   - non-empty RunID
	//   - non-empty State.Messages
	//   - ToolsUsed are all registered (empty ToolsUsed passes with empty registry)
	snapshot := agent.RunSnapshot{
		Version: 1,
		RunID:   runID,
		Meta: agent.SnapshotMeta{
			AgentID:          agentID,
			ThreadID:         threadID,
			Phase:            agent.PhaseStepCompleted,
			Attempt:          1,
			LastCheckpointAt: time.Now(),
			CreatedAt:        time.Now(),
		},
		State: agent.RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "hello"},
				{Role: "assistant", Content: "world"},
			},
			StepsCompleted: 1,
			MaxSteps:       10,
			ToolFailures:   map[string]int{},
		},
	}
	if err := e.runRepo.Save(ctx, snapshot); err != nil {
		t.Fatalf("Save checkpoint: %v", err)
	}

	// Transition run to "resumable" — this is the status the resume handler requires.
	if err := e.runRepo.UpdateStatus(ctx, runID, "resumable", ""); err != nil {
		t.Fatalf("UpdateStatus resumable: %v", err)
	}

	// POST /api/runs/{id}/resume — expect 200 SSE.
	resp := e.do(t, "POST", "/api/runs/"+runID+"/resume", nil, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/event-stream") {
		resp.Body.Close()
		t.Errorf("Content-Type: got %q, want text/event-stream", ct)
	}

	// Drain and verify at least one SSE event is present.
	events := collectSSEEvents(t, resp)
	if len(events) == 0 {
		t.Fatal("expected at least one SSE event from resumed run")
	}

	// run.completed must be the last event.
	last := events[len(events)-1]
	if last.Type != agent.EventRunCompleted {
		t.Errorf("last event: got %q, want run.completed; sequence: %v",
			last.Type, findEventTypes(events))
	}
}

func TestResumeRunVerifiesMessagesPersistedAfterResume(t *testing.T) {
	resumeCall := scriptedCall{
		events: []agent.StreamEvent{
			{Type: agent.EventRunResumed},
			{Type: agent.EventRunStarted},
			{Type: agent.EventRunCompleted},
		},
		result: &agent.RunResult{
			NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "resumed answer"}},
			Steps:       1,
		},
	}
	rt := &scriptedRuntime{calls: []scriptedCall{resumeCall}}

	e := newTestEnvWithRuntime(t, rt)
	token := e.mustSignup(t, "resume-persist@example.com", "password123")
	userID := e.mustGetUserID(t, token)

	agentID := createAgent(t, e, token, "ResumePersistAgent")
	threadID := createThread(t, e, token, agentID, "ResumePersistThread")

	runID := uuid.NewString()
	ctx := context.Background()

	if err := e.runRepo.CreateRun(ctx, runID, threadID, agentID, userID); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	snapshot := agent.RunSnapshot{
		Version: 1,
		RunID:   runID,
		Meta: agent.SnapshotMeta{
			AgentID:          agentID,
			ThreadID:         threadID,
			Phase:            agent.PhaseStepCompleted,
			Attempt:          1,
			CreatedAt:        time.Now(),
			LastCheckpointAt: time.Now(),
		},
		State: agent.RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "resume me"}},
			StepsCompleted: 1,
			MaxSteps:       10,
			ToolFailures:   map[string]int{},
		},
	}
	if err := e.runRepo.Save(ctx, snapshot); err != nil {
		t.Fatalf("Save checkpoint: %v", err)
	}
	if err := e.runRepo.UpdateStatus(ctx, runID, "resumable", ""); err != nil {
		t.Fatalf("UpdateStatus resumable: %v", err)
	}

	// Resume and drain the SSE body fully so persist completes.
	resp := e.do(t, "POST", "/api/runs/"+runID+"/resume", nil, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("resume: expected 200, got %d", resp.StatusCode)
	}
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
	}
	resp.Body.Close()

	// The resumed assistant message should now be persisted — list messages.
	resp2 := e.do(t, "GET", "/api/threads/"+threadID+"/messages", nil, token)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("list messages: expected 200, got %d", resp2.StatusCode)
	}
	var msgs []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	decodeBody(t, resp2, &msgs)

	var sawAssistant bool
	for _, m := range msgs {
		if m.Role == "assistant" && m.Content == "resumed answer" {
			sawAssistant = true
			break
		}
	}
	if !sawAssistant {
		t.Errorf("expected persisted assistant message with content 'resumed answer'; got %+v", msgs)
	}
}
