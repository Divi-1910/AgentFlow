package sqliterepo

import (
	"context"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/memory"
	"backend/model"
)

func TestRunCheckpointRetentionTimestamps(t *testing.T) {
	db := testDBInternal(t)
	repo := NewRunRepo(db)
	ctx := context.Background()
	if err := repo.CreateRun(ctx, "retention", "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	snap := agent.RunSnapshot{
		Version: 1, RunID: "retention",
		State: agent.RuntimeState{Messages: []llm.ChatMessage{{Role: "user", Content: "hi"}}, StepsCompleted: 1},
	}
	if err := repo.Save(ctx, snap); err != nil {
		t.Fatalf("Save: %v", err)
	}
	before := time.Now().UTC()
	if err := repo.UpdateStatus(ctx, "retention", string(model.RunStatusCompleted), ""); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	var expires int64
	if err := db.QueryRow(`SELECT expires_at FROM run_checkpoints WHERE run_id = ?`, "retention").Scan(&expires); err != nil {
		t.Fatalf("expires_at: %v", err)
	}
	got := timeFromUnixNano(expires)
	if got.Before(before.Add(retentionCompleted)) || got.After(time.Now().UTC().Add(retentionCompleted+time.Second)) {
		t.Fatalf("completed retention = %s", got)
	}
}

func TestRejectedTaskKeyIsNotStored(t *testing.T) {
	db := testDBInternal(t)
	repo := NewTaskRepo(db)
	ctx := context.Background()
	if err := repo.EnsureTask(ctx, "task", "u", 1); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	if _, ok, err := repo.TryConsumeRun(ctx, "task", "u", "accepted"); err != nil || !ok {
		t.Fatalf("accepted: ok=%v err=%v", ok, err)
	}
	if _, ok, err := repo.TryConsumeRun(ctx, "task", "u", "rejected"); err != nil || ok {
		t.Fatalf("rejected: ok=%v err=%v", ok, err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM task_run_keys WHERE budget_key = 'rejected'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rejected key count = %d, err=%v", count, err)
	}
}

func TestCancelTaskPreservesBudgetAndAutoCreatesMissingTask(t *testing.T) {
	db := testDBInternal(t)
	repo := NewTaskRepo(db)
	ctx := context.Background()

	if err := repo.EnsureTask(ctx, "origin", "user-1", 4); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	if _, ok, err := repo.TryConsumeRun(ctx, "origin", "user-1", "key-1"); err != nil || !ok {
		t.Fatalf("TryConsumeRun: ok=%v err=%v", ok, err)
	}
	cancelled, err := repo.IsCancelled(ctx, "origin")
	if err != nil || cancelled {
		t.Fatalf("IsCancelled before cancel: cancelled=%v err=%v", cancelled, err)
	}
	if err := repo.CancelTask(ctx, "origin", "cancelled"); err != nil {
		t.Fatalf("CancelTask: %v", err)
	}
	cancelled, err = repo.IsCancelled(ctx, "origin")
	if err != nil || !cancelled {
		t.Fatalf("IsCancelled after cancel: cancelled=%v err=%v", cancelled, err)
	}
	status, err := repo.BudgetStatus(ctx, "origin")
	if err != nil || status.MaxRuns != 4 || status.RunsUsed != 1 {
		t.Fatalf("budget changed after cancel: %+v, err=%v", status, err)
	}

	// Cancelling a task that doesn't exist yet auto-creates it with the
	// default budget, matching EnsureTask's first-creation-owns-max_runs.
	if err := repo.CancelTask(ctx, "cancel-first", "cancelled"); err != nil {
		t.Fatalf("CancelTask new: %v", err)
	}
	cancelled, err = repo.IsCancelled(ctx, "cancel-first")
	if err != nil || !cancelled {
		t.Fatalf("IsCancelled for auto-created task: cancelled=%v err=%v", cancelled, err)
	}
	status, err = repo.BudgetStatus(ctx, "cancel-first")
	if err != nil || status.MaxRuns != agent.DefaultMaxTaskRuns || status.RunsUsed != 0 {
		t.Fatalf("auto-created cancel budget = %+v, want defaults, err=%v", status, err)
	}
}

func TestIsCancelledFalseForMissingAndUncancelledTask(t *testing.T) {
	db := testDBInternal(t)
	repo := NewTaskRepo(db)
	ctx := context.Background()

	cancelled, err := repo.IsCancelled(ctx, "never-created")
	if err != nil || cancelled {
		t.Fatalf("IsCancelled for missing task: cancelled=%v err=%v", cancelled, err)
	}
	if err := repo.EnsureTask(ctx, "uncancelled", "user-1", 1); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	cancelled, err = repo.IsCancelled(ctx, "uncancelled")
	if err != nil || cancelled {
		t.Fatalf("IsCancelled for uncancelled task: cancelled=%v err=%v", cancelled, err)
	}
}

// TestJobRepoCallbackTerminalTransitionRequiresExpectedStatus directly
// inspects callback_status because no port method exposes it: AwaitJob only
// surfaces the job's own Status/Error, and the list methods
// (FindQueuedCallbacks/FindExpiredRunningCallbacks) each require a specific
// callback_status to match a row at all, so neither can observe a callback
// that already reached a DIFFERENT terminal state. Mirrors
// TestRunCheckpointRetentionTimestamps' pattern: a fact the port doesn't
// expose gets a package-internal test reading the column directly.
func TestJobRepoCallbackTerminalTransitionRequiresExpectedStatus(t *testing.T) {
	db := testDBInternal(t)
	r := NewJobRepo(db)
	ctx := context.Background()

	dispatchBackground := func(toolCallID string) agent.DispatchAgentResult {
		t.Helper()
		res, err := r.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-run", OriginatorRunID: "originator-run", ParentThreadID: "parent-thread",
			ParentAgentID: "agent-a", UserID: "user-1", ToolCallID: toolCallID,
			DelegateTool: "ask_researcher", TargetAgentID: "agent-b", Task: "research",
			Mode: agent.JobModeBackground,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		return res
	}
	callbackStatus := func(jobID string) string {
		t.Helper()
		var status string
		if err := db.QueryRow(`SELECT callback_status FROM jobs WHERE job_id = ?`, jobID).Scan(&status); err != nil {
			t.Fatalf("query callback_status for %s: %v", jobID, err)
		}
		return status
	}

	// running -> terminal: a completed callback must not be flipped by a
	// late write for the SAME callback run id.
	running := dispatchBackground("dispatch-cb-running")
	if _, ok, err := r.ClaimJobStarting(ctx, running.JobID, "owner-a", time.Minute); err != nil || !ok {
		t.Fatalf("ClaimJobStarting: ok=%v err=%v", ok, err)
	}
	if applied, err := r.MarkJobDispatched(ctx, running.JobID, "owner-a", "child-run", "child-thread"); err != nil || !applied {
		t.Fatalf("MarkJobDispatched: applied=%v err=%v", applied, err)
	}
	if applied, err := r.MarkJobSucceeded(ctx, running.JobID, "child-run", "output"); err != nil || !applied {
		t.Fatalf("MarkJobSucceeded: applied=%v err=%v", applied, err)
	}
	if applied, err := r.MarkCallbackRunning(ctx, running.JobID, "callback-run-1", "owner-a", time.Minute); err != nil || !applied {
		t.Fatalf("MarkCallbackRunning: applied=%v err=%v", applied, err)
	}
	if err := r.MarkCallbackCompleted(ctx, running.JobID, "callback-run-1"); err != nil {
		t.Fatalf("MarkCallbackCompleted: %v", err)
	}
	if err := r.MarkCallbackFailed(ctx, running.JobID, "callback-run-1", "late failure"); err != nil {
		t.Fatalf("late MarkCallbackFailed: %v", err)
	}
	if got := callbackStatus(running.JobID); got != string(agent.CallbackStatusCompleted) {
		t.Fatalf("callback_status = %q, want %q (late failure must not overwrite completed)", got, agent.CallbackStatusCompleted)
	}

	// queued -> terminal: a cancelled-before-start callback must not be
	// flipped by a late write ALSO using the empty run id.
	queued := dispatchBackground("dispatch-cb-queued")
	if err := r.MarkCallbackCancelled(ctx, queued.JobID, "", "originator cancelled"); err != nil {
		t.Fatalf("MarkCallbackCancelled: %v", err)
	}
	if err := r.MarkCallbackFailed(ctx, queued.JobID, "", "late failure"); err != nil {
		t.Fatalf("late MarkCallbackFailed (queued path): %v", err)
	}
	if got := callbackStatus(queued.JobID); got != string(agent.CallbackStatusCancelled) {
		t.Fatalf("callback_status = %q, want %q (late failure must not overwrite cancelled)", got, agent.CallbackStatusCancelled)
	}
}

func TestConstraintCodeClassification(t *testing.T) {
	db := testDBInternal(t)
	now := unixNano(time.Now())
	insert := func() error {
		_, err := db.Exec(`INSERT INTO threads(id, user_id, agent_id, title, created_at, updated_at) VALUES('same','u','a','t',?,?)`, now, now)
		return err
	}
	if err := insert(); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	err := insert()
	code, ok := constraintCode(err)
	if err == nil || !ok || code&0xff != 19 {
		t.Fatalf("constraintCode(%v) = %d, %v", err, code, ok)
	}
}

func TestMemoryRevisionConstraintRecovery(t *testing.T) {
	db := testDBInternal(t)
	repo := NewMemoryRevisionRepo(db)
	ctx := context.Background()
	base := memory.MemoryRevision{
		LineageKey: "lineage", Revision: 1, MutationID: "mutation", RunID: "run",
		ToolCallID: "call", Operation: memory.OperationCreate, UserID: "u", AgentID: "a",
		ThreadID: "t", MemoryID: "m", Scope: memory.ScopeUser, Type: memory.TypeFact,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if _, replay, err := repo.Append(ctx, base); err != nil || replay {
		t.Fatalf("first append: replay=%v err=%v", replay, err)
	}
	changed := base
	changed.Revision = 99
	if got, replay, err := repo.Append(ctx, changed); err != nil || !replay || got.Revision != 1 {
		t.Fatalf("mutation recovery: got=%+v replay=%v err=%v", got, replay, err)
	}
	collision := base
	collision.MutationID = "other"
	if _, replay, err := repo.Append(ctx, collision); err != memory.ErrRevisionConflict || replay {
		t.Fatalf("revision collision: replay=%v err=%v", replay, err)
	}
}

func TestMessageJSONCorruptionReturnsDecodeError(t *testing.T) {
	db := testDBInternal(t)
	now := unixNano(time.Now())
	_, err := db.Exec(`INSERT INTO messages(id, thread_id, agent_id, user_id, role, content, tool_calls_json, created_at)
VALUES('m','t','a','u','assistant','bad','{',?)`, now)
	if err != nil {
		t.Fatalf("insert corrupt message: %v", err)
	}
	_, err = NewMessageRepo(db).ListDocsByThread(context.Background(), "t", 1)
	if err == nil || !strings.Contains(err.Error(), "decode JSON") {
		t.Fatalf("ListDocsByThread error = %v", err)
	}
}

func TestMalformedCheckpointBlobReturnsDecompressionError(t *testing.T) {
	db := testDBInternal(t)
	now := unixNano(time.Now())
	_, err := db.Exec(`INSERT INTO run_checkpoints(run_id, step, snapshot_gz, created_at) VALUES('bad',1,?,?)`, []byte("not gzip"), now)
	if err != nil {
		t.Fatalf("insert malformed checkpoint: %v", err)
	}
	_, err = NewRunRepo(db).LoadLatest(context.Background(), "bad")
	if err == nil || !strings.Contains(err.Error(), "decompress checkpoint") {
		t.Fatalf("LoadLatest error = %v", err)
	}
}
