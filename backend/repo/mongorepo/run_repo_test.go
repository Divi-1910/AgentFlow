package mongorepo_test

import (
	"context"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/model"
	"backend/repo/mongorepo"

	"github.com/google/uuid"
)

// newRunRepo creates a RunRepo with isolated collections and ensures indexes.
func newRunRepo(t *testing.T) *mongorepo.RunRepo {
	t.Helper()
	r := mongorepo.NewRunRepo(col(t, "runs"), col(t, "checkpoints"))
	if err := r.EnsureIndexes(context.Background()); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}
	return r
}

// minimalSnapshot returns the smallest valid RunSnapshot for save/load tests.
func minimalSnapshot(runID string, steps int) agent.RunSnapshot {
	return agent.RunSnapshot{
		Version: 1,
		RunID:   runID,
		State: agent.RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "hello"}},
			StepsCompleted: steps,
			MaxSteps:       10,
			ToolFailures:   map[string]int{},
		},
		Meta: agent.SnapshotMeta{
			AgentID:          "agent1",
			ThreadID:         "thread1",
			Provider:         "openai",
			Model:            "gpt-4o",
			Phase:            agent.PhaseStepCompleted,
			Attempt:          1,
			CreatedAt:        time.Now(),
			LastCheckpointAt: time.Now(),
		},
	}
}

// ── CreateRun / GetRun ────────────────────────────────────────────────────────

func TestRunRepoCreateRunSetsInitialState(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "thread1", "agent1", "user1"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	info, err := r.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if info.RunID != runID {
		t.Errorf("RunID: got %q, want %q", info.RunID, runID)
	}
	if info.Status != string(model.RunStatusRunning) {
		t.Errorf("Status: got %q, want %q", info.Status, model.RunStatusRunning)
	}
	if info.Attempt != 1 {
		t.Errorf("Attempt: got %d, want 1", info.Attempt)
	}
	if info.ThreadID != "thread1" {
		t.Errorf("ThreadID: got %q, want %q", info.ThreadID, "thread1")
	}
	if info.UserID != "user1" {
		t.Errorf("UserID: got %q, want %q", info.UserID, "user1")
	}
}

// ── GetRunForUser ─────────────────────────────────────────────────────────────

func TestRunRepoGetRunForUserEnforcesOwnership(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "thread1", "agent1", "user1"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	_, err := r.GetRunForUser(ctx, runID, "user2")
	if err == nil {
		t.Fatal("expected error for wrong user, got nil")
	}
}

func TestRunRepoGetRunForUserCorrectOwner(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "thread1", "agent1", "user1"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	info, err := r.GetRunForUser(ctx, runID, "user1")
	if err != nil {
		t.Fatalf("GetRunForUser: %v", err)
	}
	if info.RunID != runID {
		t.Errorf("RunID: got %q, want %q", info.RunID, runID)
	}
}

// ── TransitionStatus CAS ──────────────────────────────────────────────────────

func TestRunRepoTransitionStatusCASWinsOnCorrectFrom(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	ok, err := r.TransitionStatus(ctx, runID, string(model.RunStatusRunning), string(model.RunStatusCompleted))
	if err != nil {
		t.Fatalf("TransitionStatus: %v", err)
	}
	if !ok {
		t.Fatal("expected transition to succeed")
	}

	info, err := r.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if info.Status != string(model.RunStatusCompleted) {
		t.Errorf("Status: got %q, want %q", info.Status, model.RunStatusCompleted)
	}
}

func TestRunRepoTransitionStatusCASLosesOnWrongFrom(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	// Status is "running", but we claim it's "resumable" → should not match.
	ok, err := r.TransitionStatus(ctx, runID, string(model.RunStatusResumable), string(model.RunStatusRunning))
	if err != nil {
		t.Fatalf("TransitionStatus: %v", err)
	}
	if ok {
		t.Fatal("expected transition to fail (wrong 'from' status)")
	}

	// Status should be unchanged.
	info, err := r.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if info.Status != string(model.RunStatusRunning) {
		t.Errorf("Status changed unexpectedly: got %q, want %q", info.Status, model.RunStatusRunning)
	}
}

func TestRunRepoTransitionStatusIdempotentAfterFirstWin(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	// First transition succeeds.
	ok1, err := r.TransitionStatus(ctx, runID, string(model.RunStatusRunning), string(model.RunStatusCompleted))
	if err != nil {
		t.Fatalf("first TransitionStatus: %v", err)
	}
	if !ok1 {
		t.Fatal("expected first transition to succeed")
	}

	// Second transition on the same edge — status is already completed, not running.
	ok2, err := r.TransitionStatus(ctx, runID, string(model.RunStatusRunning), string(model.RunStatusCompleted))
	if err != nil {
		t.Fatalf("second TransitionStatus: %v", err)
	}
	if ok2 {
		t.Fatal("expected second transition to fail (already transitioned)")
	}
}

// ── TransitionStatusForUser ───────────────────────────────────────────────────

func TestRunRepoTransitionStatusForUserWrongUser(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "user1"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	ok, err := r.TransitionStatusForUser(ctx, runID, "user2", string(model.RunStatusRunning), string(model.RunStatusCompleted))
	if err != nil {
		t.Fatalf("TransitionStatusForUser: %v", err)
	}
	if ok {
		t.Fatal("expected transition to fail for wrong user")
	}
}

func TestRunRepoTransitionStatusForUserCorrectUser(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "user1"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	ok, err := r.TransitionStatusForUser(ctx, runID, "user1", string(model.RunStatusRunning), string(model.RunStatusCompleted))
	if err != nil {
		t.Fatalf("TransitionStatusForUser: %v", err)
	}
	if !ok {
		t.Fatal("expected transition to succeed for correct user")
	}
}

// ── Save / LoadLatest ─────────────────────────────────────────────────────────

func TestRunRepoSaveAndLoadLatestRoundTrip(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "thread1", "agent1", "user1"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	snap := minimalSnapshot(runID, 2)
	if err := r.Save(ctx, snap); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := r.LoadLatest(ctx, runID)
	if err != nil {
		t.Fatalf("LoadLatest: %v", err)
	}
	if loaded.RunID != runID {
		t.Errorf("RunID: got %q, want %q", loaded.RunID, runID)
	}
	if loaded.State.StepsCompleted != 2 {
		t.Errorf("StepsCompleted: got %d, want 2", loaded.State.StepsCompleted)
	}
	if len(loaded.State.Messages) != 1 {
		t.Errorf("Messages: got %d, want 1", len(loaded.State.Messages))
	}
}

func TestRunRepoLoadLatestReturnsHighestStep(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	// Save three checkpoints out of order.
	for _, steps := range []int{1, 3, 2} {
		if err := r.Save(ctx, minimalSnapshot(runID, steps)); err != nil {
			t.Fatalf("Save(steps=%d): %v", steps, err)
		}
	}

	loaded, err := r.LoadLatest(ctx, runID)
	if err != nil {
		t.Fatalf("LoadLatest: %v", err)
	}
	// Index on (run_id, step DESC) → latest = step 3.
	if loaded.State.StepsCompleted != 3 {
		t.Errorf("StepsCompleted: got %d, want 3 (highest step)", loaded.State.StepsCompleted)
	}
}

func TestRunRepoLoadLatestErrorOnMissingCheckpoint(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	_, err := r.LoadLatest(ctx, runID)
	if err == nil {
		t.Fatal("expected error for run with no checkpoints, got nil")
	}
}

// ── Save updates steps_completed on run document ──────────────────────────────

func TestRunRepoSaveUpdatesStepsCompleted(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	if err := r.Save(ctx, minimalSnapshot(runID, 7)); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := r.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if info.StepsCompleted != 7 {
		t.Errorf("StepsCompleted: got %d, want 7", info.StepsCompleted)
	}
}

// ── IncrementAttempt ──────────────────────────────────────────────────────────

func TestRunRepoIncrementAttemptIsMonotonic(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	a1, err := r.IncrementAttempt(ctx, runID)
	if err != nil {
		t.Fatalf("IncrementAttempt 1: %v", err)
	}
	a2, err := r.IncrementAttempt(ctx, runID)
	if err != nil {
		t.Fatalf("IncrementAttempt 2: %v", err)
	}
	if a2 <= a1 {
		t.Errorf("attempts not monotonic: a1=%d a2=%d", a1, a2)
	}
}

// ── UpdateStatus ──────────────────────────────────────────────────────────────

func TestRunRepoUpdateStatusPersistsLastError(t *testing.T) {
	r := newRunRepo(t)
	ctx := context.Background()

	runID := uuid.NewString()
	if err := r.CreateRun(ctx, runID, "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	if err := r.UpdateStatus(ctx, runID, string(model.RunStatusFailed), "something broke"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}

	info, err := r.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if info.Status != string(model.RunStatusFailed) {
		t.Errorf("Status: got %q, want %q", info.Status, model.RunStatusFailed)
	}
	if info.LastError != "something broke" {
		t.Errorf("LastError: got %q, want %q", info.LastError, "something broke")
	}
}
