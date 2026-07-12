// Package conformancetest holds backend-agnostic conformance suites that pin the
// OBSERVABLE behavior of each storage port — the atomicity, idempotency, and
// monotonicity guarantees that method signatures alone do not capture.
//
// Each suite is a Run*Conformance(t, factory) function: the factory returns a
// fresh, ready-to-use store (indexes ensured, collection isolated) per call, so
// the suite is independent of any concrete backend. Today the Mongo repositories
// are wired to these suites (see repo/mongorepo/conformance_test.go); when the
// SQLite backend lands for the Runtime, wiring it to the SAME suites is the
// operational definition of "it behaves like the Studio's store."
//
// The assertions are DESCRIPTIVE, not aspirational: they encode what the current
// Mongo implementation actually does today — including quirks (e.g. EnsureTask's
// first-creation-owns-max_runs, DispatchAgent returning the existing job on a
// differing replay). A second backend must reproduce these exactly, or the
// divergence must be a deliberate, documented decision.
package conformancetest

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"backend/agent"
	"backend/dispatcher"
	"backend/llm"
	"backend/memory"
	"backend/runtimectx"
)

// 24-char hex ids for the thread/message suites (those repos parse ids as
// Mongo ObjectIDs at the edge; the rest of the ports treat ids as opaque
// strings).
const (
	hexUser    = "507f1f77bcf86cd799439101"
	hexOther   = "507f1f77bcf86cd799439102"
	hexAgentA  = "507f1f77bcf86cd799439103"
	hexAgentB  = "507f1f77bcf86cd799439104"
	hexThread  = "507f1f77bcf86cd799439105"
	hexThreadB = "507f1f77bcf86cd799439106"
)

// ── Run / checkpoint ────────────────────────────────────────────────────────

type RunStore interface {
	agent.CheckpointStore
	CreateChildRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID string) error
}

// RunCheckpointConformance pins agent.CheckpointStore: status transitions are an
// atomic compare-and-set, attempt counting is monotonic, and LoadLatest returns
// the highest-step snapshot (not merely the last written).
func RunCheckpointConformance(t *testing.T, newStore func(t *testing.T) RunStore) {
	ctx := context.Background()

	t.Run("create_then_get_roundtrip", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-1", "thread-1", "agent-1", "user-1"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		info, err := s.GetRun(ctx, "run-1")
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if info.ThreadID != "thread-1" || info.AgentID != "agent-1" || info.UserID != "user-1" {
			t.Fatalf("run identity not preserved: %+v", info)
		}
		if info.Attempt != 1 {
			t.Errorf("fresh run Attempt = %d, want 1", info.Attempt)
		}
	})

	t.Run("child_lineage_roundtrip", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateChildRun(ctx, "child-1", "thread-child", "agent-child", "owner", "root-1", "parent-1"); err != nil {
			t.Fatalf("CreateChildRun: %v", err)
		}
		info, err := s.GetRun(ctx, "child-1")
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if info.OriginatorRunID != "root-1" || info.ParentRunID != "parent-1" || info.InvocationKind != agent.InvocationSyncDelegate {
			t.Fatalf("child lineage not preserved: %+v", info)
		}
	})

	t.Run("owner_scoped_read", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-owner", "t", "a", "owner"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		if _, err := s.GetRunForUser(ctx, "run-owner", "intruder"); err == nil {
			t.Fatal("GetRunForUser for non-owner must fail")
		}
		if _, err := s.GetRunForUser(ctx, "run-owner", "owner"); err != nil {
			t.Fatalf("GetRunForUser(owner): %v", err)
		}
	})

	t.Run("status_error_updates_preserve_existing_error_on_empty", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-status", "t", "a", "u"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		if err := s.UpdateStatus(ctx, "run-status", "failed", "first error"); err != nil {
			t.Fatalf("UpdateStatus(error): %v", err)
		}
		if err := s.UpdateStatus(ctx, "run-status", "resumable", ""); err != nil {
			t.Fatalf("UpdateStatus(empty): %v", err)
		}
		info, err := s.GetRun(ctx, "run-status")
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if info.Status != "resumable" || info.LastError != "first error" {
			t.Fatalf("status/error = %q/%q, want resumable/first error", info.Status, info.LastError)
		}
	})

	t.Run("transition_status_is_atomic_cas", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-cas", "t", "a", "u"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		info, err := s.GetRun(ctx, "run-cas")
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		from := info.Status

		ok, err := s.TransitionStatus(ctx, "run-cas", from, "conf-next")
		if err != nil {
			t.Fatalf("TransitionStatus: %v", err)
		}
		if !ok {
			t.Fatal("first transition from current status must succeed")
		}
		// The status is now "conf-next"; a second transition keyed on the old
		// `from` must NOT match — this is the claim that makes resume safe.
		ok, err = s.TransitionStatus(ctx, "run-cas", from, "conf-other")
		if err != nil {
			t.Fatalf("TransitionStatus(2): %v", err)
		}
		if ok {
			t.Fatal("transition from a stale status must fail (CAS)")
		}
	})

	t.Run("transition_status_for_user_scoped", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-u", "t", "a", "owner"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		info, _ := s.GetRun(ctx, "run-u")
		from := info.Status

		ok, err := s.TransitionStatusForUser(ctx, "run-u", "intruder", from, "conf-x")
		if err != nil {
			t.Fatalf("TransitionStatusForUser(wrong user): %v", err)
		}
		if ok {
			t.Fatal("transition for a non-owning user must fail")
		}
		ok, err = s.TransitionStatusForUser(ctx, "run-u", "owner", from, "conf-x")
		if err != nil {
			t.Fatalf("TransitionStatusForUser(owner): %v", err)
		}
		if !ok {
			t.Fatal("transition for the owning user must succeed")
		}
	})

	t.Run("increment_attempt_is_monotonic", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-inc", "t", "a", "u"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		a1, err := s.IncrementAttempt(ctx, "run-inc")
		if err != nil {
			t.Fatalf("IncrementAttempt: %v", err)
		}
		a2, err := s.IncrementAttempt(ctx, "run-inc")
		if err != nil {
			t.Fatalf("IncrementAttempt(2): %v", err)
		}
		if a1 != 2 || a2 != 3 {
			t.Fatalf("attempts = %d, %d; want post-increment 2, 3", a1, a2)
		}
	})

	t.Run("loadlatest_returns_highest_step", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-ckpt", "t", "a", "u"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		// Save out of order: the highest STEP must win, not the last written.
		for _, step := range []int{1, 3, 2} {
			if err := s.Save(ctx, snapshot("run-ckpt", step)); err != nil {
				t.Fatalf("Save(step=%d): %v", step, err)
			}
		}
		got, err := s.LoadLatest(ctx, "run-ckpt")
		if err != nil {
			t.Fatalf("LoadLatest: %v", err)
		}
		if got.State.StepsCompleted != 3 {
			t.Fatalf("LoadLatest step = %d, want highest (3)", got.State.StepsCompleted)
		}
	})

	t.Run("transition_status_concurrent_single_winner", func(t *testing.T) {
		s := newStore(t)
		if err := s.CreateRun(ctx, "run-race", "t", "a", "u"); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
		info, err := s.GetRun(ctx, "run-race")
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		from := info.Status

		// 50 goroutines race the SAME from→to CAS. They all park on a shared
		// start channel and are released together, so the calls genuinely
		// overlap — a per-goroutine staggered start could let a broken
		// read-then-write run effectively serially and pass by luck. A real
		// atomic CAS yields exactly one winner; a SELECT-then-UPDATE would let
		// several win. This is the property that makes "exactly one resume
		// claims the run" hold.
		const n = 50
		var (
			spawned sync.WaitGroup // every goroutine exists and is parked on start
			done    sync.WaitGroup
			wins    atomic.Int32
		)
		start := make(chan struct{})
		spawned.Add(n)
		done.Add(n)
		for range n {
			go func() {
				defer done.Done()
				spawned.Done()
				<-start // released simultaneously to maximize contention
				ok, err := s.TransitionStatus(ctx, "run-race", from, "claimed")
				if err != nil {
					t.Errorf("TransitionStatus: %v", err)
					return
				}
				if ok {
					wins.Add(1)
				}
			}()
		}
		spawned.Wait() // all goroutines parked on start
		close(start)   // go!
		done.Wait()
		if got := wins.Load(); got != 1 {
			t.Fatalf("concurrent CAS winners = %d, want exactly 1", got)
		}
	})
}

func snapshot(runID string, step int) agent.RunSnapshot {
	return agent.RunSnapshot{
		Version: 1,
		RunID:   runID,
		State: agent.RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "hi"}},
			StepsCompleted: step,
			MaxSteps:       10,
		},
		Meta: agent.SnapshotMeta{AgentID: "a", ThreadID: "t"},
	}
}

// ── Task run-budget ─────────────────────────────────────────────────────────

// TaskStore is the run-budget port (TaskRepo). Defined here (consumer-side) so
// the suite does not depend on the dispatcher's unexported interface.
type TaskStore interface {
	EnsureTask(ctx context.Context, originatorRunID, userID string, maxRuns int) error
	TryConsumeRun(ctx context.Context, originatorRunID, userID, budgetKey string) (agent.RunBudgetStatus, bool, error)
	BudgetStatus(ctx context.Context, originatorRunID string) (agent.RunBudgetStatus, error)
}

// RunTaskBudgetConformance pins the run-budget contract: the first creation owns
// max_runs, consumption is an atomic check-cap-and-increment, and a repeated
// budget key is idempotent (never double-charged).
func RunTaskBudgetConformance(t *testing.T, newStore func(t *testing.T) TaskStore) {
	ctx := context.Background()

	t.Run("first_creation_owns_max_runs", func(t *testing.T) {
		s := newStore(t)
		if err := s.EnsureTask(ctx, "orig-1", "u", 5); err != nil {
			t.Fatalf("EnsureTask: %v", err)
		}
		// A later EnsureTask with a DIFFERENT max_runs must NOT overwrite the
		// value the first creation set (setOnInsert semantics).
		if err := s.EnsureTask(ctx, "orig-1", "u", 99); err != nil {
			t.Fatalf("EnsureTask(2): %v", err)
		}
		st, err := s.BudgetStatus(ctx, "orig-1")
		if err != nil {
			t.Fatalf("BudgetStatus: %v", err)
		}
		if st.MaxRuns != 5 {
			t.Fatalf("MaxRuns = %d, want 5 (first creation owns it)", st.MaxRuns)
		}
	})

	t.Run("consume_is_idempotent_by_key", func(t *testing.T) {
		s := newStore(t)
		if err := s.EnsureTask(ctx, "orig-idem", "u", 3); err != nil {
			t.Fatalf("EnsureTask: %v", err)
		}
		st, ok, err := s.TryConsumeRun(ctx, "orig-idem", "u", "key-1")
		if err != nil || !ok {
			t.Fatalf("first consume: ok=%v err=%v", ok, err)
		}
		if st.RunsUsed != 1 {
			t.Fatalf("RunsUsed after first consume = %d, want 1", st.RunsUsed)
		}
		// Same key again: succeeds without charging a second run.
		st, ok, err = s.TryConsumeRun(ctx, "orig-idem", "u", "key-1")
		if err != nil || !ok {
			t.Fatalf("replay consume: ok=%v err=%v", ok, err)
		}
		if st.RunsUsed != 1 {
			t.Fatalf("RunsUsed after replay = %d, want still 1 (idempotent)", st.RunsUsed)
		}
	})

	t.Run("consume_caps_at_max_runs", func(t *testing.T) {
		s := newStore(t)
		if err := s.EnsureTask(ctx, "orig-cap", "u", 2); err != nil {
			t.Fatalf("EnsureTask: %v", err)
		}
		for i, key := range []string{"k1", "k2"} {
			_, ok, err := s.TryConsumeRun(ctx, "orig-cap", "u", key)
			if err != nil || !ok {
				t.Fatalf("consume %d (%s): ok=%v err=%v", i, key, ok, err)
			}
		}
		st, ok, err := s.TryConsumeRun(ctx, "orig-cap", "u", "k3")
		if err != nil {
			t.Fatalf("over-cap consume: %v", err)
		}
		if ok {
			t.Fatal("consuming past max_runs must fail")
		}
		if !st.Exhausted {
			t.Fatalf("status should be Exhausted at the cap: %+v", st)
		}
	})

	t.Run("consume_creates_absent_task", func(t *testing.T) {
		s := newStore(t)
		status, ok, err := s.TryConsumeRun(ctx, "orig-absent", "u", "first")
		if err != nil {
			t.Fatalf("TryConsumeRun: %v", err)
		}
		if !ok || status.RunsUsed != 1 || status.MaxRuns != agent.DefaultMaxTaskRuns {
			t.Fatalf("absent task consume = (%+v, %v), want admitted default ledger", status, ok)
		}
	})

	t.Run("accepted_key_replays_after_exhaustion", func(t *testing.T) {
		s := newStore(t)
		if err := s.EnsureTask(ctx, "orig-replay", "u", 1); err != nil {
			t.Fatalf("EnsureTask: %v", err)
		}
		if _, ok, err := s.TryConsumeRun(ctx, "orig-replay", "u", "accepted"); err != nil || !ok {
			t.Fatalf("first consume: ok=%v err=%v", ok, err)
		}
		if status, ok, err := s.TryConsumeRun(ctx, "orig-replay", "u", "accepted"); err != nil || !ok || status.RunsUsed != 1 {
			t.Fatalf("accepted replay after exhaustion: status=%+v ok=%v err=%v", status, ok, err)
		}
	})

	t.Run("rejected_key_replays_as_rejected", func(t *testing.T) {
		s := newStore(t)
		if err := s.EnsureTask(ctx, "orig-rejected", "u", 1); err != nil {
			t.Fatalf("EnsureTask: %v", err)
		}
		if _, ok, err := s.TryConsumeRun(ctx, "orig-rejected", "u", "accepted"); err != nil || !ok {
			t.Fatalf("accepted consume: ok=%v err=%v", ok, err)
		}
		for i := 0; i < 2; i++ {
			status, ok, err := s.TryConsumeRun(ctx, "orig-rejected", "u", "rejected")
			if err != nil || ok || !status.Exhausted || status.RunsUsed != 1 {
				t.Fatalf("rejected replay %d: status=%+v ok=%v err=%v", i, status, ok, err)
			}
		}
	})

	t.Run("consume_concurrent_respects_cap", func(t *testing.T) {
		s := newStore(t)
		if err := s.EnsureTask(ctx, "orig-race", "u", 1); err != nil {
			t.Fatalf("EnsureTask: %v", err)
		}
		// 50 goroutines, each a DISTINCT budget key (so idempotency can't mask a
		// double-charge), race to consume a budget of 1. They park on a shared
		// start channel and are released together so the consumes truly overlap;
		// a staggered start could let a broken read-then-write run serially and
		// pass by luck. A real atomic check-cap-and-increment grants exactly one.
		const n = 50
		var (
			spawned sync.WaitGroup
			done    sync.WaitGroup
			granted atomic.Int32
		)
		start := make(chan struct{})
		spawned.Add(n)
		done.Add(n)
		for i := range n {
			key := fmt.Sprintf("key-%d", i)
			go func() {
				defer done.Done()
				spawned.Done()
				<-start // released simultaneously to maximize contention
				_, ok, err := s.TryConsumeRun(ctx, "orig-race", "u", key)
				if err != nil {
					t.Errorf("TryConsumeRun: %v", err)
					return
				}
				if ok {
					granted.Add(1)
				}
			}()
		}
		spawned.Wait() // all goroutines parked on start
		close(start)   // go!
		done.Wait()
		if got := granted.Load(); got != 1 {
			t.Fatalf("concurrent grants = %d, want exactly 1 (cap=1)", got)
		}
		st, err := s.BudgetStatus(ctx, "orig-race")
		if err != nil {
			t.Fatalf("BudgetStatus: %v", err)
		}
		if st.RunsUsed != 1 {
			t.Fatalf("RunsUsed = %d after race, want 1", st.RunsUsed)
		}
	})
}

// ── Async jobs ──────────────────────────────────────────────────────────────

// RunAsyncJobConformance pins agent.AsyncJobStore dispatch/await: a dispatch is
// idempotent by (parent_run_id, tool_call_id), and a freshly dispatched job is
// pending until it reaches a terminal status.
func RunAsyncJobConformance(t *testing.T, newStore func(t *testing.T) agent.AsyncJobStore) {
	ctx := context.Background()

	t.Run("dispatch_idempotent_returns_existing_on_replay", func(t *testing.T) {
		s := newStore(t)
		first, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-1", OriginatorRunID: "orig-1", UserID: "u",
			ToolCallID: "call-1", TargetAgentID: "target", Task: "do A", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if first.JobID == "" {
			t.Fatal("dispatch must return a job id")
		}
		// Replay the SAME (parent_run_id, tool_call_id) with a DIFFERENT payload:
		// the existing job is returned unchanged — the differing task does not
		// conflict and does not create a second job.
		again, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-1", OriginatorRunID: "orig-1", UserID: "u",
			ToolCallID: "call-1", TargetAgentID: "target", Task: "do B (different)", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent(replay): %v", err)
		}
		if again.JobID != first.JobID {
			t.Fatalf("replay job id = %q, want existing %q", again.JobID, first.JobID)
		}
	})

	t.Run("await_is_pending_until_terminal", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-2", OriginatorRunID: "orig-2", UserID: "u",
			ToolCallID: "call-2", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		res, err := s.AwaitJob(ctx, agent.AwaitJobRequest{
			JobID: d.JobID, UserID: "u", OriginatorRunID: "orig-2",
		})
		if err != nil {
			t.Fatalf("AwaitJob: %v", err)
		}
		if !res.Pending {
			t.Fatalf("a freshly queued job must be Pending: %+v", res)
		}
	})

	t.Run("pending_required_jobs_lists_undelivered", func(t *testing.T) {
		s := newStore(t)
		required1, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-3", OriginatorRunID: "orig-3", UserID: "u",
			ToolCallID: "call-3a", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent required1: %v", err)
		}
		required2, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-3", OriginatorRunID: "orig-3", UserID: "u",
			ToolCallID: "call-3b", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent required2: %v", err)
		}
		// A background job on the same parent run must not appear in the
		// required-jobs listing.
		if _, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-3", OriginatorRunID: "orig-3", UserID: "u",
			ToolCallID: "call-3c", TargetAgentID: "target", Task: "t", Mode: agent.JobModeBackground,
		}); err != nil {
			t.Fatalf("DispatchAgent background: %v", err)
		}
		pending, err := s.PendingRequiredJobs(ctx, "parent-3", "u")
		if err != nil {
			t.Fatalf("PendingRequiredJobs: %v", err)
		}
		got := map[string]bool{}
		for _, p := range pending {
			got[p.JobID] = true
		}
		if len(pending) != 2 || !got[required1.JobID] || !got[required2.JobID] {
			t.Fatalf("PendingRequiredJobs = %+v, want exactly %s and %s", pending, required1.JobID, required2.JobID)
		}
	})

	t.Run("mark_awaiting_resolves_as_not_all_terminal", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-4", OriginatorRunID: "orig-4", UserID: "u",
			ToolCallID: "call-4", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		await := agent.PendingAwait{JobID: d.JobID, AwaitToolCallID: "await-call-4", CreatedAt: time.Now()}
		if err := s.MarkAwaiting(ctx, "parent-4", []agent.PendingAwait{await}); err != nil {
			t.Fatalf("MarkAwaiting: %v", err)
		}
		results, allTerminal, err := s.ResolveAwaits(ctx, "parent-4", "u", []agent.PendingAwait{await})
		if err != nil {
			t.Fatalf("ResolveAwaits: %v", err)
		}
		if allTerminal {
			t.Fatal("allTerminal = true, want false while the job is still pending")
		}
		if len(results) != 1 || !results[0].Pending {
			t.Fatalf("results = %+v, want a single pending result", results)
		}
	})

	t.Run("mark_delivered_clears_from_pending", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-5", OriginatorRunID: "orig-5", UserID: "u",
			ToolCallID: "call-5", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		await := agent.PendingAwait{JobID: d.JobID, AwaitToolCallID: "await-call-5", CreatedAt: time.Now()}
		terminal := agent.AwaitJobResult{JobID: d.JobID, Status: "succeeded", Output: "done"}
		if err := s.MarkDelivered(ctx, "parent-5", "u", []agent.AwaitJobResult{terminal}, []agent.PendingAwait{await}); err != nil {
			t.Fatalf("MarkDelivered: %v", err)
		}
		pending, err := s.PendingRequiredJobs(ctx, "parent-5", "u")
		if err != nil {
			t.Fatalf("PendingRequiredJobs: %v", err)
		}
		for _, p := range pending {
			if p.JobID == d.JobID {
				t.Fatalf("PendingRequiredJobs still lists delivered job %s", d.JobID)
			}
		}
	})
}

// JobLifecycleStore is the full job-repo surface these two suites need: seed
// jobs the way the runtime does (agent.AsyncJobStore.DispatchAgent), then
// exercise the coordinator and worker ports under test. One concrete job
// repo implements all three — there is no other seam to create a fresh job.
type JobLifecycleStore interface {
	agent.AsyncJobStore
	dispatcher.CoordinatorJobStore
	dispatcher.WorkerJobStore
}

// RunCoordinatorJobConformance pins dispatcher.CoordinatorJobStore: claim CAS
// (queued and expired-starting are reclaimable, running is not), lock
// acquire/release owner-fencing, MarkJobDispatched's claim-owner fencing,
// FindReadyWaitingRunIDs' all-terminal grouping, and cancellation before a
// job is ever dispatched.
func RunCoordinatorJobConformance(t *testing.T, newStore func(t *testing.T) JobLifecycleStore) {
	ctx := context.Background()

	t.Run("claim_starting_admits_queued_rejects_unexpired_running", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c1", OriginatorRunID: "orig-c1", UserID: "u",
			ToolCallID: "call-c1", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		claimed, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute)
		if err != nil || !ok || claimed.JobID != d.JobID {
			t.Fatalf("claim queued job: ok=%v err=%v claimed=%+v", ok, err, claimed)
		}
		_, ok, err = s.ClaimJobStarting(ctx, d.JobID, "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("claim unexpired starting: %v", err)
		}
		if ok {
			t.Fatal("claimed an unexpired starting job held by another owner")
		}
	})

	t.Run("claim_starting_reclaims_expired_lease", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c2", OriginatorRunID: "orig-c2", UserID: "u",
			ToolCallID: "call-c2", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", -time.Millisecond); err != nil || !ok {
			t.Fatalf("first claim (immediately-expiring lease): ok=%v err=%v", ok, err)
		}
		claimed, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-b", time.Minute)
		if err != nil || !ok || claimed.JobID != d.JobID {
			t.Fatalf("reclaim expired starting: ok=%v err=%v claimed=%+v", ok, err, claimed)
		}
	})

	t.Run("claim_starting_rejects_running", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c3", OriginatorRunID: "orig-c3", UserID: "u",
			ToolCallID: "call-c3", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "child-thread"); err != nil || !applied {
			t.Fatalf("MarkJobDispatched: applied=%v err=%v", applied, err)
		}
		_, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("claim running job: %v", err)
		}
		if ok {
			t.Fatal("claimed a running job")
		}
	})

	t.Run("acquire_lock_same_job_requires_same_owner", func(t *testing.T) {
		s := newStore(t)
		acquired, err := s.AcquireLock(ctx, "target", "lock-c4", "job-x", "run-x", "owner-a", time.Minute)
		if err != nil || !acquired {
			t.Fatalf("first acquire: acquired=%v err=%v", acquired, err)
		}
		// Same job, DIFFERENT owner, unexpired lease: must be rejected — a
		// second coordinator can't silently steal an unexpired lease just by
		// re-asserting the same job id under a different owner.
		reacquired, err := s.AcquireLock(ctx, "target", "lock-c4", "job-x", "run-x", "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("cross-owner reacquire: %v", err)
		}
		if reacquired {
			t.Fatal("a different owner reacquired an unexpired same-job lock")
		}
		// Same job, SAME owner: re-affirming (an idempotent retry of the same
		// claim attempt) is fine.
		reaffirmed, err := s.AcquireLock(ctx, "target", "lock-c4", "job-x", "run-x", "owner-a", time.Minute)
		if err != nil || !reaffirmed {
			t.Fatalf("same-owner reaffirm: acquired=%v err=%v", reaffirmed, err)
		}
	})

	t.Run("release_lock_requires_matching_owner", func(t *testing.T) {
		s := newStore(t)
		if acquired, err := s.AcquireLock(ctx, "target", "lock-c5", "job-y", "run-y", "owner-a", time.Minute); err != nil || !acquired {
			t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
		}
		if err := s.ReleaseLock(ctx, "lock-c5", "job-y", "owner-wrong"); err != nil {
			t.Fatalf("release with wrong owner: %v", err)
		}
		stillHeld, err := s.AcquireLock(ctx, "target", "lock-c5", "job-z", "run-z", "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("acquire after wrong-owner release: %v", err)
		}
		if stillHeld {
			t.Fatal("lock was released by the wrong owner")
		}
		if err := s.ReleaseLock(ctx, "lock-c5", "job-y", "owner-a"); err != nil {
			t.Fatalf("release with correct owner: %v", err)
		}
		freed, err := s.AcquireLock(ctx, "target", "lock-c5", "job-z", "run-z", "owner-b", time.Minute)
		if err != nil || !freed {
			t.Fatalf("acquire after correct release: acquired=%v err=%v", freed, err)
		}
	})

	t.Run("mark_job_dispatched_requires_claim_owner", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c6", OriginatorRunID: "orig-c6", UserID: "u",
			ToolCallID: "call-c6", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		// A wrong-owner dispatch must report applied=false and be a no-op:
		// the job stays "starting" under owner-a, so the correct-owner
		// dispatch below must still succeed.
		applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-wrong", "child-run-wrong", "child-thread-wrong")
		if err != nil {
			t.Fatalf("MarkJobDispatched(wrong owner): %v", err)
		}
		if applied {
			t.Fatal("MarkJobDispatched applied with the wrong owner")
		}
		applied, err = s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "child-thread")
		if err != nil || !applied {
			t.Fatalf("MarkJobDispatched(correct owner): applied=%v err=%v", applied, err)
		}
		expired, err := s.FindExpiredRunningJobs(ctx, time.Now().Add(time.Hour), 10)
		if err != nil {
			t.Fatalf("FindExpiredRunningJobs: %v", err)
		}
		var found *agent.JobRecord
		for i := range expired {
			if expired[i].JobID == d.JobID {
				found = &expired[i]
			}
		}
		if found == nil || found.ChildRunID != "child-run" {
			t.Fatalf("job not correctly dispatched: expired=%+v", expired)
		}
	})

	t.Run("mark_claimed_job_failed_requires_claim_owner", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c9", OriginatorRunID: "orig-c9", UserID: "u",
			ToolCallID: "call-c9", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		// This is the pre-dispatch path: child_run_id is never persisted at
		// this point, so fencing must be on the claim owner, not a run id.
		applied, err := s.MarkClaimedJobFailed(ctx, d.JobID, "owner-wrong", "boom")
		if err != nil {
			t.Fatalf("MarkClaimedJobFailed(wrong owner): %v", err)
		}
		if applied {
			t.Fatal("MarkClaimedJobFailed applied with the wrong owner")
		}
		applied, err = s.MarkClaimedJobFailed(ctx, d.JobID, "owner-a", "boom")
		if err != nil || !applied {
			t.Fatalf("MarkClaimedJobFailed(correct owner): applied=%v err=%v", applied, err)
		}
		_, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("claim after failure: %v", err)
		}
		if ok {
			t.Fatal("claimed an already-failed job")
		}
	})

	t.Run("mark_job_cancelled_before_dispatch_uses_empty_child_run_id_fence", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c8", OriginatorRunID: "orig-c8", UserID: "u",
			ToolCallID: "call-c8", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		// Still queued — never claimed/dispatched — child_run_id is unset.
		if applied, err := s.MarkJobCancelled(ctx, d.JobID, "", "originator cancelled"); err != nil || !applied {
			t.Fatalf("MarkJobCancelled: applied=%v err=%v", applied, err)
		}
		_, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute)
		if err != nil {
			t.Fatalf("claim cancelled job: %v", err)
		}
		if ok {
			t.Fatal("claimed an already-cancelled job")
		}
	})

	t.Run("ready_waiting_run_ids_requires_all_awaiting_jobs_terminal", func(t *testing.T) {
		s := newStore(t)
		d1, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c7", OriginatorRunID: "orig-c7", UserID: "u",
			ToolCallID: "call-c7a", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent d1: %v", err)
		}
		d2, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c7", OriginatorRunID: "orig-c7", UserID: "u",
			ToolCallID: "call-c7b", TargetAgentID: "target2", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent d2: %v", err)
		}
		if err := s.MarkAwaiting(ctx, "parent-c7", []agent.PendingAwait{{JobID: d1.JobID}, {JobID: d2.JobID}}); err != nil {
			t.Fatalf("MarkAwaiting: %v", err)
		}

		assertNotReady := func(t *testing.T) {
			t.Helper()
			ready, err := s.FindReadyWaitingRunIDs(ctx, 10)
			if err != nil {
				t.Fatalf("FindReadyWaitingRunIDs: %v", err)
			}
			for _, runID := range ready {
				if runID == "parent-c7" {
					t.Fatalf("parent-c7 reported ready too early: ready=%v", ready)
				}
			}
		}
		assertNotReady(t)
		if applied, err := s.MarkJobSucceeded(ctx, d1.JobID, "", "done-1"); err != nil || !applied {
			t.Fatalf("MarkJobSucceeded d1: applied=%v err=%v", applied, err)
		}
		assertNotReady(t) // d2 is still pending

		if applied, err := s.MarkJobSucceeded(ctx, d2.JobID, "", "done-2"); err != nil || !applied {
			t.Fatalf("MarkJobSucceeded d2: applied=%v err=%v", applied, err)
		}
		ready, err := s.FindReadyWaitingRunIDs(ctx, 10)
		if err != nil {
			t.Fatalf("FindReadyWaitingRunIDs: %v", err)
		}
		found := false
		for _, runID := range ready {
			if runID == "parent-c7" {
				found = true
			}
		}
		if !found {
			t.Fatalf("parent-c7 not ready after both awaiting jobs succeeded: ready=%v", ready)
		}
	})

	t.Run("mark_callback_cancelled_before_start_then_running_is_rejected", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-c10", OriginatorRunID: "orig-c10", UserID: "u",
			ToolCallID: "call-c10", TargetAgentID: "target", Task: "t", Mode: agent.JobModeBackground,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		// Callback is still "queued" — never claimed. Cancel it via the
		// empty-run-id, pre-start path: this must fence on callback_status
		// being "queued", not just on the (empty) callback_run_id, or a
		// racing terminal write could apply after the callback already left
		// "queued".
		if err := s.MarkCallbackCancelled(ctx, d.JobID, "", "originator cancelled"); err != nil {
			t.Fatalf("MarkCallbackCancelled: %v", err)
		}
		// It's now terminal (cancelled), not "queued" — a later claim
		// attempt must be rejected, proving the cancellation actually
		// transitioned it (not a silent no-op) and that the terminal state
		// sticks (not reclaimable).
		applied, err := s.MarkCallbackRunning(ctx, d.JobID, "late-callback-run", "owner-a", time.Minute)
		if err != nil {
			t.Fatalf("MarkCallbackRunning after cancellation: %v", err)
		}
		if applied {
			t.Fatal("claimed a callback that was already cancelled before start")
		}
	})
}

// RunWorkerJobConformance pins dispatcher.WorkerJobStore: terminal writes and
// lease refreshes fence on the child/callback run id supplied — a call
// carrying a mismatched run id (e.g. a stale or duplicate bus delivery) is a
// no-op rather than clobbering the job's real outcome — and a callback's own
// failure never overwrites the job's own Error.
func RunWorkerJobConformance(t *testing.T, newStore func(t *testing.T) JobLifecycleStore) {
	ctx := context.Background()

	t.Run("mark_job_succeeded_requires_matching_child_run_id", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-w1", OriginatorRunID: "orig-w1", UserID: "u",
			ToolCallID: "call-w1", TargetAgentID: "target", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run-1", "thread-1"); err != nil || !applied {
			t.Fatalf("dispatch: applied=%v err=%v", applied, err)
		}
		// A completion write carrying the WRONG child run id (e.g. a stale or
		// duplicate bus delivery) must report applied=false and be a no-op —
		// the job stays running, untouched, under its real child run.
		applied, err := s.MarkJobSucceeded(ctx, d.JobID, "wrong-child-run", "stale output")
		if err != nil {
			t.Fatalf("mismatched MarkJobSucceeded: %v", err)
		}
		if applied {
			t.Fatal("MarkJobSucceeded applied with a mismatched child run id")
		}
		expired, err := s.FindExpiredRunningJobs(ctx, time.Now().Add(time.Hour), 10)
		if err != nil {
			t.Fatalf("FindExpiredRunningJobs: %v", err)
		}
		var found *agent.JobRecord
		for i := range expired {
			if expired[i].JobID == d.JobID {
				found = &expired[i]
			}
		}
		if found == nil {
			t.Fatal("job vanished from the running set — mismatched completion incorrectly applied")
		}
		if found.Status != string(agent.JobStatusRunning) || found.ChildRunID != "child-run-1" {
			t.Fatalf("job state after mismatched write = %+v, want still running under child-run-1", found)
		}
		// The call carrying the CORRECT child run id applies for real.
		applied, err = s.MarkJobSucceeded(ctx, d.JobID, "child-run-1", "real output")
		if err != nil || !applied {
			t.Fatalf("matching MarkJobSucceeded: applied=%v err=%v", applied, err)
		}
		res, err := s.AwaitJob(ctx, agent.AwaitJobRequest{JobID: d.JobID, UserID: "u", OriginatorRunID: "orig-w1"})
		if err != nil {
			t.Fatalf("AwaitJob: %v", err)
		}
		if res.Pending || res.Output != "real output" {
			t.Fatalf("final job state = %+v, want terminal with real output", res)
		}
	})

	t.Run("callback_failure_does_not_overwrite_job_error", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-w2", OriginatorRunID: "orig-w2", UserID: "u",
			ToolCallID: "call-w2", TargetAgentID: "target", Task: "t", Mode: agent.JobModeBackground,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "thread"); err != nil || !applied {
			t.Fatalf("dispatch: applied=%v err=%v", applied, err)
		}
		if applied, err := s.MarkJobSucceeded(ctx, d.JobID, "child-run", "job output"); err != nil || !applied {
			t.Fatalf("MarkJobSucceeded: applied=%v err=%v", applied, err)
		}
		applied, err := s.MarkCallbackRunning(ctx, d.JobID, "callback-run-1", "owner-a", time.Minute)
		if err != nil || !applied {
			t.Fatalf("MarkCallbackRunning: applied=%v err=%v", applied, err)
		}
		if err := s.MarkCallbackFailed(ctx, d.JobID, "callback-run-1", "callback blew up"); err != nil {
			t.Fatalf("MarkCallbackFailed: %v", err)
		}
		res, err := s.AwaitJob(ctx, agent.AwaitJobRequest{JobID: d.JobID, UserID: "u", OriginatorRunID: "orig-w2"})
		if err != nil {
			t.Fatalf("AwaitJob: %v", err)
		}
		if res.Error != "" || res.Output != "job output" || res.Status != string(agent.JobStatusSucceeded) {
			t.Fatalf("callback failure corrupted the job's own outcome: %+v", res)
		}
	})

	t.Run("mark_callback_running_reports_applied_and_rejects_replay", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-w3", OriginatorRunID: "orig-w3", UserID: "u",
			ToolCallID: "call-w3", TargetAgentID: "target", Task: "t", Mode: agent.JobModeBackground,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "thread"); err != nil || !applied {
			t.Fatalf("dispatch: applied=%v err=%v", applied, err)
		}
		if applied, err := s.MarkJobSucceeded(ctx, d.JobID, "child-run", "output"); err != nil || !applied {
			t.Fatalf("MarkJobSucceeded: applied=%v err=%v", applied, err)
		}
		applied, err := s.MarkCallbackRunning(ctx, d.JobID, "callback-run-1", "owner-a", time.Minute)
		if err != nil || !applied {
			t.Fatalf("first MarkCallbackRunning: applied=%v err=%v", applied, err)
		}
		// Already running: a second claim attempt must report applied=false,
		// not silently succeed and let two callback runs both believe they
		// own it.
		applied, err = s.MarkCallbackRunning(ctx, d.JobID, "callback-run-2", "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("second MarkCallbackRunning: %v", err)
		}
		if applied {
			t.Fatal("MarkCallbackRunning claimed an already-running callback")
		}
	})

	t.Run("refresh_job_lease_fences_on_child_run_id", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-w4", OriginatorRunID: "orig-w4", UserID: "u",
			ToolCallID: "call-w4", TargetAgentID: "target-w4", Task: "t", Mode: agent.JobModeRequired,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "thread"); err != nil || !applied {
			t.Fatalf("dispatch: applied=%v err=%v", applied, err)
		}
		if err := s.RefreshJobLease(ctx, d.JobID, "child-run", "orig-w4", "target-w4", "worker:child-run", time.Minute); err != nil {
			t.Fatalf("refresh with correct child run: %v", err)
		}
		if err := s.RefreshJobLease(ctx, d.JobID, "some-other-run", "orig-w4", "target-w4", "worker:other", time.Minute); err == nil {
			t.Fatal("refresh with mismatched child run id succeeded, want error")
		}
	})

	t.Run("refresh_callback_lease_fences_on_callback_run_id", func(t *testing.T) {
		s := newStore(t)
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-w5", OriginatorRunID: "orig-w5", UserID: "u",
			ToolCallID: "call-w5", TargetAgentID: "target", Task: "t", Mode: agent.JobModeBackground,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "thread-w5"); err != nil || !applied {
			t.Fatalf("dispatch: applied=%v err=%v", applied, err)
		}
		if applied, err := s.MarkJobSucceeded(ctx, d.JobID, "child-run", "output"); err != nil || !applied {
			t.Fatalf("MarkJobSucceeded: applied=%v err=%v", applied, err)
		}
		if applied, err := s.MarkCallbackRunning(ctx, d.JobID, "callback-run", "owner-a", time.Minute); err != nil || !applied {
			t.Fatalf("MarkCallbackRunning: applied=%v err=%v", applied, err)
		}
		if err := s.RefreshCallbackLease(ctx, d.JobID, "callback-run", "thread-w5", "worker:callback-run", time.Minute); err != nil {
			t.Fatalf("refresh with correct callback run: %v", err)
		}
		if err := s.RefreshCallbackLease(ctx, d.JobID, "some-other-callback-run", "thread-w5", "worker:other", time.Minute); err == nil {
			t.Fatal("refresh with mismatched callback run id succeeded, want error")
		}
	})

	t.Run("mark_callback_terminal_mismatched_run_id_does_not_release_current_attempts_lock", func(t *testing.T) {
		s := newStore(t)
		// ParentThreadID must be set: markCallbackTerminal's internal
		// auto-release reconstructs the callback lock key from the job's own
		// parent_thread_id, the same "callback_thread:"+threadID convention
		// dispatcher.JobCoordinator uses to construct it in the first place.
		d, err := s.DispatchAgent(ctx, agent.DispatchAgentRequest{
			ParentRunID: "parent-w6", OriginatorRunID: "orig-w6", ParentThreadID: "thread-w6", UserID: "u",
			ToolCallID: "call-w6", TargetAgentID: "target", Task: "t", Mode: agent.JobModeBackground,
		})
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
		if _, ok, err := s.ClaimJobStarting(ctx, d.JobID, "owner-a", time.Minute); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		if applied, err := s.MarkJobDispatched(ctx, d.JobID, "owner-a", "child-run", "child-thread-w6"); err != nil || !applied {
			t.Fatalf("dispatch: applied=%v err=%v", applied, err)
		}
		if applied, err := s.MarkJobSucceeded(ctx, d.JobID, "child-run", "output"); err != nil || !applied {
			t.Fatalf("MarkJobSucceeded: applied=%v err=%v", applied, err)
		}
		lockKey := "callback_thread:thread-w6"
		if acquired, err := s.AcquireLock(ctx, "callback_thread", lockKey, d.JobID, "callback-run-1", "owner-a", time.Minute); err != nil || !acquired {
			t.Fatalf("acquire callback lock: acquired=%v err=%v", acquired, err)
		}
		applied, err := s.MarkCallbackRunning(ctx, d.JobID, "callback-run-1", "owner-a", time.Minute)
		if err != nil || !applied {
			t.Fatalf("MarkCallbackRunning: applied=%v err=%v", applied, err)
		}
		// A mismatched terminal write (wrong callback run id) must not release
		// the lock the CURRENT legitimate callback attempt still holds.
		if err := s.MarkCallbackFailed(ctx, d.JobID, "wrong-callback-run", "stale error"); err != nil {
			t.Fatalf("mismatched MarkCallbackFailed: %v", err)
		}
		stillHeld, err := s.AcquireLock(ctx, "callback_thread", lockKey, "other-job", "other-run", "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("acquire attempt: %v", err)
		}
		if stillHeld {
			t.Fatal("mismatched terminal write released the current callback attempt's lock")
		}
		// The correctly-matching write DOES apply and DOES release the lock.
		if err := s.MarkCallbackCompleted(ctx, d.JobID, "callback-run-1"); err != nil {
			t.Fatalf("matching MarkCallbackCompleted: %v", err)
		}
		freed, err := s.AcquireLock(ctx, "callback_thread", lockKey, "other-job", "other-run", "owner-b", time.Minute)
		if err != nil {
			t.Fatalf("acquire after real completion: %v", err)
		}
		if !freed {
			t.Fatal("lock not released after the matching callback completed")
		}
	})
}

// ── Memory metadata projection ──────────────────────────────────────────────

// RunMemoryMetaConformance pins memory.MetaStore.Upsert: projection is monotonic
// (a stale revision never overwrites a newer row) and never clobbers last_read_at.
func RunMemoryMetaConformance(t *testing.T, newStore func(t *testing.T) memory.MetaStore) {
	ctx := context.Background()
	now := time.Now()

	// execScope is the run's FULL coordinates. The runtime always supplies all
	// three (user/agent/thread), so every search below reuses it — a backend that
	// validates a complete scope must be exercised with one.
	execScope := runtimectx.MemoryScope{UserID: "u-meta", AgentID: "a-meta", ThreadID: "t-meta"}
	doc := func(rev int, summary string) memory.MemoryDocument {
		return memory.MemoryDocument{
			LineageKey: "lin-meta",
			UserID:     execScope.UserID,
			AgentID:    execScope.AgentID,
			ThreadID:   execScope.ThreadID,
			ID:         "m1",
			Scope:      memory.ScopeUser,
			Type:       memory.TypeFact,
			Revision:   rev,
			Summary:    summary,
			CreatedAt:  now,
			UpdatedAt:  now,
		}
	}
	read := func(t *testing.T, s memory.MetaStore) memory.MemoryDocument {
		docs, err := s.FindActive(ctx, execScope, memory.ScopeUser, nil, false, now)
		if err != nil {
			t.Fatalf("FindActive: %v", err)
		}
		if len(docs) != 1 {
			t.Fatalf("FindActive returned %d docs, want 1", len(docs))
		}
		return docs[0]
	}
	// mkAt builds a metadata doc at explicit coordinates (used for cross-tenant
	// decoys). The lineage-key derivation requires user/agent/thread on every
	// record; the Scope field discriminates lineage, and distinct ids never
	// collide.
	mkAt := func(scope string, sc runtimectx.MemoryScope, id, typ string) memory.MemoryDocument {
		return memory.MemoryDocument{
			UserID:    sc.UserID,
			AgentID:   sc.AgentID,
			ThreadID:  sc.ThreadID,
			ID:        id,
			Scope:     scope,
			Type:      typ,
			Revision:  1,
			CreatedAt: now,
			UpdatedAt: now,
		}
	}
	// mk is the common case: a record inside execScope's tenant.
	mk := func(scope, id, typ string) memory.MemoryDocument {
		return mkAt(scope, execScope, id, typ)
	}
	upsert := func(t *testing.T, s memory.MetaStore, d memory.MemoryDocument) {
		t.Helper()
		if err := s.Upsert(ctx, d); err != nil {
			t.Fatalf("Upsert(%s/%s): %v", d.Scope, d.ID, err)
		}
	}
	// memKey is a record's TRUE identity. memory_id is unique only WITHIN a scope
	// (the repo's lineage key / partial unique indexes scope it), so the same
	// memory_id may legitimately exist at user, agent, and thread scope — asserting
	// on bare memory_id would wrongly treat those as collisions.
	memKey := func(d memory.MemoryDocument) string { return d.Scope + "/" + d.ID }
	// findIDs returns the set of (scope, memory_id) identities FindActive yields,
	// asserting the adapter never returns the same identity twice.
	findIDs := func(t *testing.T, s memory.MetaStore, searchScope string, typeFilter *string, includeRetired bool) map[string]bool {
		t.Helper()
		docs, err := s.FindActive(ctx, execScope, searchScope, typeFilter, includeRetired, now)
		if err != nil {
			t.Fatalf("FindActive(%s): %v", searchScope, err)
		}
		ids := make(map[string]bool, len(docs))
		for _, d := range docs {
			k := memKey(d)
			if ids[k] {
				t.Fatalf("FindActive(%s) returned duplicate identity %q", searchScope, k)
			}
			ids[k] = true
		}
		return ids
	}
	// assertIDs checks EXACT set equality on (scope, memory_id) identities — it
	// catches an adapter that returns the right COUNT of the wrong records.
	assertIDs := func(t *testing.T, got map[string]bool, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("FindActive identity set = %v, want exactly %v", got, want)
		}
		for _, id := range want {
			if !got[id] {
				t.Fatalf("FindActive identity set = %v, missing %q (want exactly %v)", got, id, want)
			}
		}
	}

	t.Run("stale_revision_does_not_regress", func(t *testing.T) {
		s := newStore(t)
		if err := s.Upsert(ctx, doc(2, "v2")); err != nil {
			t.Fatalf("Upsert(rev2): %v", err)
		}
		// A stale (lower) revision must be ignored.
		if err := s.Upsert(ctx, doc(1, "v1")); err != nil {
			t.Fatalf("Upsert(rev1): %v", err)
		}
		got := read(t, s)
		if got.Revision != 2 || got.Summary != "v2" {
			t.Fatalf("after stale upsert: rev=%d summary=%q, want rev=2 summary=v2", got.Revision, got.Summary)
		}
	})

	t.Run("upsert_preserves_last_read_at", func(t *testing.T) {
		s := newStore(t)
		if err := s.Upsert(ctx, doc(1, "v1")); err != nil {
			t.Fatalf("Upsert: %v", err)
		}
		if err := s.StampRead(ctx, doc(1, "v1")); err != nil {
			t.Fatalf("StampRead: %v", err)
		}
		// A subsequent projection must not clear the read stamp.
		if err := s.Upsert(ctx, doc(2, "v2")); err != nil {
			t.Fatalf("Upsert(rev2): %v", err)
		}
		got := read(t, s)
		if got.LastReadAt == nil {
			t.Fatal("Upsert clobbered last_read_at (must be preserved)")
		}
	})

	t.Run("find_active_scope_expansion", func(t *testing.T) {
		s := newStore(t)
		// One reachable record per scope — crucially, each sits at coordinates the
		// scope is supposed to IGNORE: the user record under a different
		// agent+thread, the agent record under a different thread. A correct
		// backend still returns them; one that over-filters (user memory by
		// agent/thread, or agent memory by thread) would wrongly drop them.
		upsert(t, s, mkAt(memory.ScopeUser, runtimectx.MemoryScope{UserID: "u-meta", AgentID: "a-ignored", ThreadID: "t-ignored"}, "mem-user", memory.TypeFact))
		upsert(t, s, mkAt(memory.ScopeAgent, runtimectx.MemoryScope{UserID: "u-meta", AgentID: "a-meta", ThreadID: "t-ignored"}, "mem-agent", memory.TypeFact))
		upsert(t, s, mk(memory.ScopeThread, "mem-thread", memory.TypeFact))
		// …plus cross-tenant decoys that must NEVER surface for execScope: a
		// different user; the same user but a different agent; the same agent but
		// a different thread. These DO violate a dimension the scope checks, so
		// their exclusion (alongside the ignored-coordinate records' inclusion)
		// proves the filter keys on exactly the right coordinates.
		upsert(t, s, mkAt(memory.ScopeUser, runtimectx.MemoryScope{UserID: "u-other", AgentID: "a-other", ThreadID: "t-other"}, "decoy-user", memory.TypeFact))
		upsert(t, s, mkAt(memory.ScopeAgent, runtimectx.MemoryScope{UserID: "u-meta", AgentID: "a-other", ThreadID: "t-other"}, "decoy-agent", memory.TypeFact))
		upsert(t, s, mkAt(memory.ScopeThread, runtimectx.MemoryScope{UserID: "u-meta", AgentID: "a-meta", ThreadID: "t-other"}, "decoy-thread", memory.TypeFact))

		// Exact identities: thread→thread; agent→agent+thread; user→all three.
		// No decoy appears; the ignored-coordinate records still do.
		assertIDs(t, findIDs(t, s, memory.ScopeThread, nil, false), "thread/mem-thread")
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, false), "agent/mem-agent", "thread/mem-thread")
		assertIDs(t, findIDs(t, s, memory.ScopeUser, nil, false), "user/mem-user", "agent/mem-agent", "thread/mem-thread")
	})

	t.Run("find_active_excludes_expired", func(t *testing.T) {
		s := newStore(t)
		past := now.Add(-time.Hour)
		expired := mk(memory.ScopeAgent, "mem-expired", memory.TypeFact)
		expired.ExpiresAt = &past
		upsert(t, s, mk(memory.ScopeAgent, "mem-live", memory.TypeFact))
		upsert(t, s, expired)
		// Exactly the live record by identity — never the expired one.
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, false), "agent/mem-live")
	})

	t.Run("find_active_excludes_soft_deleted", func(t *testing.T) {
		s := newStore(t)
		upsert(t, s, mk(memory.ScopeAgent, "mem-del", memory.TypeFact))
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, false), "agent/mem-del")
		if err := s.SoftDelete(ctx, "a-meta", memory.ScopeAgent, "mem-del"); err != nil {
			t.Fatalf("SoftDelete: %v", err)
		}
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, false)) // empty set
	})

	t.Run("find_active_retired_filtering", func(t *testing.T) {
		s := newStore(t)
		retired := mk(memory.ScopeAgent, "mem-retired", memory.TypeFact)
		retired.RetiredAt = &now
		upsert(t, s, retired)
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, false))                     // excluded by default
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, true), "agent/mem-retired") // included on request
	})

	t.Run("find_active_type_filtering", func(t *testing.T) {
		s := newStore(t)
		upsert(t, s, mk(memory.ScopeAgent, "mem-fact", memory.TypeFact))
		upsert(t, s, mk(memory.ScopeAgent, "mem-pref", memory.TypePreference))
		factType := memory.TypeFact
		// Exactly the fact record — the preference is filtered out by identity.
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, &factType, false), "agent/mem-fact")
	})

	t.Run("find_expired_discovers_only_due_live_rows", func(t *testing.T) {
		s := newStore(t)
		past := now.Add(-time.Minute)
		future := now.Add(time.Minute)
		due := mk(memory.ScopeAgent, "due", memory.TypeFact)
		due.ExpiresAt = &past
		later := mk(memory.ScopeAgent, "later", memory.TypeFact)
		later.ExpiresAt = &future
		upsert(t, s, due)
		upsert(t, s, later)
		expired, err := s.FindExpired(ctx, now)
		if err != nil {
			t.Fatalf("FindExpired: %v", err)
		}
		if len(expired) != 1 || expired[0].ID != "due" {
			t.Fatalf("FindExpired = %+v, want only due", expired)
		}
	})

	t.Run("stamp_read_missing_row_is_noop", func(t *testing.T) {
		s := newStore(t)
		missing := mk(memory.ScopeAgent, "missing", memory.TypeFact)
		if err := s.StampRead(ctx, missing); err != nil {
			t.Fatalf("StampRead(missing): %v", err)
		}
		assertIDs(t, findIDs(t, s, memory.ScopeAgent, nil, false))
	})
}

// ── Memory revisions ────────────────────────────────────────────────────────

// RunMemoryRevisionConformance pins memory.RevisionStore.Append: it is idempotent
// by mutation_id (a replay returns the existing revision, not a duplicate) and
// rejects the same mutation_id reused across a different lineage.
func RunMemoryRevisionConformance(t *testing.T, newStore func(t *testing.T) memory.RevisionStore) {
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	rev := func(lineage string, n int, mutationID string) memory.MemoryRevision {
		return memory.MemoryRevision{
			LineageKey: lineage,
			Revision:   n,
			MutationID: mutationID,
			RunID:      "r", ToolCallID: "c",
			Operation: memory.OperationCreate,
			UserID:    "u", AgentID: "a", ThreadID: "t", MemoryID: "m",
			Scope: memory.ScopeUser, Type: memory.TypeFact,
			CreatedAt: now, UpdatedAt: now,
		}
	}

	t.Run("append_then_latest", func(t *testing.T) {
		s := newStore(t)
		if _, _, err := s.Append(ctx, rev("lin-a", 1, "mut-1")); err != nil {
			t.Fatalf("Append(1): %v", err)
		}
		if _, _, err := s.Append(ctx, rev("lin-a", 2, "mut-2")); err != nil {
			t.Fatalf("Append(2): %v", err)
		}
		latest, err := s.Latest(ctx, "lin-a")
		if err != nil {
			t.Fatalf("Latest: %v", err)
		}
		if latest == nil || latest.Revision != 2 {
			t.Fatalf("Latest = %+v, want revision 2", latest)
		}
	})

	t.Run("append_idempotent_by_mutation_id", func(t *testing.T) {
		s := newStore(t)
		if _, replayed, err := s.Append(ctx, rev("lin-b", 1, "mut-x")); err != nil || replayed {
			t.Fatalf("first append: replayed=%v err=%v (want fresh insert)", replayed, err)
		}
		// Same mutation id + same lineage: returns the existing revision, no dup.
		if _, replayed, err := s.Append(ctx, rev("lin-b", 1, "mut-x")); err != nil || !replayed {
			t.Fatalf("replay append: replayed=%v err=%v (want replay=true)", replayed, err)
		}
		all, err := s.List(ctx, "lin-b")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(all) != 1 {
			t.Fatalf("List returned %d revisions, want 1 (idempotent)", len(all))
		}
	})

	t.Run("same_mutation_different_lineage_conflicts", func(t *testing.T) {
		s := newStore(t)
		if _, _, err := s.Append(ctx, rev("lin-c1", 1, "mut-shared")); err != nil {
			t.Fatalf("Append: %v", err)
		}
		_, _, err := s.Append(ctx, rev("lin-c2", 1, "mut-shared"))
		if err != memory.ErrRevisionConflict {
			t.Fatalf("reusing a mutation id across lineages: err = %v, want ErrRevisionConflict", err)
		}
	})

	t.Run("same_lineage_revision_different_mutation_conflicts", func(t *testing.T) {
		s := newStore(t)
		if _, _, err := s.Append(ctx, rev("lin-d", 1, "mut-d1")); err != nil {
			t.Fatalf("Append: %v", err)
		}
		// A different mutation cannot claim an already-taken (lineage, revision):
		// the unique (lineage_key, revision) index rejects it, and since the new
		// mutation id is not found, it surfaces as a conflict (not a replay).
		_, replayed, err := s.Append(ctx, rev("lin-d", 1, "mut-d2"))
		if err != memory.ErrRevisionConflict {
			t.Fatalf("colliding (lineage, revision): err = %v, want ErrRevisionConflict", err)
		}
		if replayed {
			t.Fatal("a true conflict must not be reported as an idempotent replay")
		}
	})

	t.Run("complete_revision_roundtrip", func(t *testing.T) {
		s := newStore(t)
		restoredFrom := 3
		expires := now.Add(24 * time.Hour)
		retired := now.Add(48 * time.Hour)
		want := memory.MemoryRevision{
			LineageKey: "lin-full", Revision: 4, MutationID: "mut-full",
			RunID: "run-full", ToolCallID: "call-full", Operation: memory.OperationRestore,
			Reason: "restore it", RestoredFrom: &restoredFrom,
			UserID: "user-full", AgentID: "agent-full", ThreadID: "thread-full",
			MemoryID: "memory-full", Scope: memory.ScopeThread, Type: memory.TypeProcedure,
			Importance: 0.75, BodyPath: "body/full.md", CreatedAt: now, UpdatedAt: now.Add(time.Second),
			ExpiresAt: &expires, RetiredAt: &retired,
		}
		if _, _, err := s.Append(ctx, want); err != nil {
			t.Fatalf("Append: %v", err)
		}
		got, err := s.FindRevision(ctx, want.LineageKey, want.Revision)
		if err != nil {
			t.Fatalf("FindRevision: %v", err)
		}
		if got == nil || got.MutationID != want.MutationID || got.RunID != want.RunID || got.ToolCallID != want.ToolCallID ||
			got.Operation != want.Operation || got.Reason != want.Reason || got.RestoredFrom == nil || *got.RestoredFrom != restoredFrom ||
			got.UserID != want.UserID || got.AgentID != want.AgentID || got.ThreadID != want.ThreadID || got.MemoryID != want.MemoryID ||
			got.Scope != want.Scope || got.Type != want.Type || got.Importance != want.Importance || got.BodyPath != want.BodyPath ||
			!got.CreatedAt.Equal(want.CreatedAt) || !got.UpdatedAt.Equal(want.UpdatedAt) || got.ExpiresAt == nil || !got.ExpiresAt.Equal(expires) ||
			got.RetiredAt == nil || !got.RetiredAt.Equal(retired) {
			t.Fatalf("revision round-trip mismatch:\n got: %+v\nwant: %+v", got, want)
		}
		byMutation, err := s.FindByMutation(ctx, want.MutationID)
		if err != nil || byMutation == nil || byMutation.LineageKey != want.LineageKey {
			t.Fatalf("FindByMutation = %+v, %v", byMutation, err)
		}
		list, err := s.List(ctx, want.LineageKey)
		if err != nil || len(list) != 1 || list[0].Revision != want.Revision {
			t.Fatalf("List = %+v, %v", list, err)
		}
	})
}

// ── Thread (thin round-trip) ────────────────────────────────────────────────

// ThreadStore is the thread persistence port (consumer-defined here).
type ThreadStore interface {
	Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error)
	GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error)
	ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error)
	UpdateSummary(ctx context.Context, threadID, userID, summary string) error
	FindOrCreateSubThread(ctx context.Context, userID, originatorRunID, agentID string) (string, error)
}

// RunThreadConformance pins the neutral thread record round-trip: ids come back
// as non-empty strings, ownership is enforced, and summary updates persist.
func RunThreadConformance(t *testing.T, newStore func(t *testing.T) ThreadStore) {
	ctx := context.Background()

	t.Run("create_get_roundtrip", func(t *testing.T) {
		s := newStore(t)
		created, err := s.Create(ctx, hexUser, hexAgentA, "my thread")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if created.ID == "" {
			t.Fatal("record id must be a non-empty string")
		}
		if created.Title != "my thread" || created.AgentID != hexAgentA || created.UserID != hexUser {
			t.Fatalf("record fields not preserved: %+v", created)
		}
		got, err := s.GetByID(ctx, created.ID, hexUser)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if got.ID != created.ID || got.Title != "my thread" {
			t.Fatalf("round-trip mismatch: %+v", got)
		}
	})

	t.Run("get_enforces_owner", func(t *testing.T) {
		s := newStore(t)
		created, err := s.Create(ctx, hexUser, hexAgentA, "private")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if _, err := s.GetByID(ctx, created.ID, hexOther); err == nil {
			t.Fatal("GetByID for a non-owning user must error")
		}
	})

	t.Run("update_summary_persists", func(t *testing.T) {
		s := newStore(t)
		created, err := s.Create(ctx, hexUser, hexAgentA, "summarize me")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if err := s.UpdateSummary(ctx, created.ID, hexUser, "the summary"); err != nil {
			t.Fatalf("UpdateSummary: %v", err)
		}
		got, err := s.GetByID(ctx, created.ID, hexUser)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if got.Summary != "the summary" {
			t.Fatalf("Summary = %q, want %q", got.Summary, "the summary")
		}
	})

	t.Run("concurrent_sub_thread_creation_converges_and_preserves_timestamps", func(t *testing.T) {
		s := newStore(t)
		const n = 40
		start := make(chan struct{})
		ids := make(chan string, n)
		var wg sync.WaitGroup
		wg.Add(n)
		for range n {
			go func() {
				defer wg.Done()
				<-start
				id, err := s.FindOrCreateSubThread(ctx, hexUser, "origin-concurrent", hexAgentA)
				if err != nil {
					t.Errorf("FindOrCreateSubThread: %v", err)
					return
				}
				ids <- id
			}()
		}
		close(start)
		wg.Wait()
		close(ids)
		var only string
		for id := range ids {
			if only == "" {
				only = id
			}
			if id != only {
				t.Fatalf("sub-thread ids diverged: %q and %q", only, id)
			}
		}
		first, err := s.GetByID(ctx, only, hexUser)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		time.Sleep(2 * time.Millisecond)
		againID, err := s.FindOrCreateSubThread(ctx, hexUser, "origin-concurrent", hexAgentA)
		if err != nil || againID != only {
			t.Fatalf("repeat FindOrCreateSubThread = %q, %v; want %q", againID, err, only)
		}
		again, err := s.GetByID(ctx, only, hexUser)
		if err != nil {
			t.Fatalf("GetByID(repeat): %v", err)
		}
		if !again.CreatedAt.Equal(first.CreatedAt) || !again.UpdatedAt.Equal(first.UpdatedAt) {
			t.Fatalf("repeat changed timestamps: first=%+v again=%+v", first, again)
		}
	})

	t.Run("user_list_excludes_sub_threads", func(t *testing.T) {
		s := newStore(t)
		regular, err := s.Create(ctx, hexUser, hexAgentA, "visible")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if _, err := s.FindOrCreateSubThread(ctx, hexUser, "origin-hidden", hexAgentA); err != nil {
			t.Fatalf("FindOrCreateSubThread: %v", err)
		}
		listed, err := s.ListByAgent(ctx, hexAgentA, hexUser)
		if err != nil {
			t.Fatalf("ListByAgent: %v", err)
		}
		if len(listed) != 1 || listed[0].ID != regular.ID {
			t.Fatalf("ListByAgent = %+v, want only regular thread %s", listed, regular.ID)
		}
	})
}

// ── Message (thin round-trip + ordering) ────────────────────────────────────

// MessageStore is the message persistence port (consumer-defined here).
type MessageStore interface {
	InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]agent.MessageRecord, error)
	ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error)
	ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error)
}

// RunMessageConformance pins the neutral message record round-trip: inserted
// messages come back in chronological order with their fields intact.
func RunMessageConformance(t *testing.T, newStore func(t *testing.T) MessageStore) {
	ctx := context.Background()

	t.Run("insert_then_list_in_chronological_order", func(t *testing.T) {
		s := newStore(t)
		// threadID and userID are DISTINCT values here, so a backend that keys
		// messages by user instead of thread can't pass by coincidence.
		if _, err := s.InsertMany(ctx, hexThread, hexAgentA, hexUser,
			[]llm.ChatMessage{{Role: "user", Content: "hello"}}); err != nil {
			t.Fatalf("InsertMany(user): %v", err)
		}
		time.Sleep(5 * time.Millisecond)
		if _, err := s.InsertMany(ctx, hexThread, hexAgentA, hexUser,
			[]llm.ChatMessage{{Role: "assistant", Content: "hi"}}); err != nil {
			t.Fatalf("InsertMany(assistant): %v", err)
		}

		docs, err := s.ListDocsByThread(ctx, hexThread, 100)
		if err != nil {
			t.Fatalf("ListDocsByThread: %v", err)
		}
		if len(docs) != 2 {
			t.Fatalf("got %d records, want 2", len(docs))
		}
		if docs[0].Role != "user" || docs[1].Role != "assistant" {
			t.Fatalf("order = [%q, %q], want [user, assistant]", docs[0].Role, docs[1].Role)
		}
		if docs[0].ID == "" {
			t.Fatal("record id must be a non-empty string")
		}
		// The record must carry the thread it was keyed by, not the user.
		if docs[0].ThreadID != hexThread {
			t.Fatalf("record ThreadID = %q, want %q (keyed by thread, not user)", docs[0].ThreadID, hexThread)
		}
	})

	t.Run("list_is_scoped_to_thread", func(t *testing.T) {
		s := newStore(t)
		// Same user, two different threads. A query for one thread must return
		// only that thread's messages — proving the key is thread, not user.
		if _, err := s.InsertMany(ctx, hexThread, hexAgentA, hexUser,
			[]llm.ChatMessage{{Role: "user", Content: "in-A"}}); err != nil {
			t.Fatalf("InsertMany(A): %v", err)
		}
		if _, err := s.InsertMany(ctx, hexThreadB, hexAgentA, hexUser,
			[]llm.ChatMessage{{Role: "user", Content: "in-B"}}); err != nil {
			t.Fatalf("InsertMany(B): %v", err)
		}
		docs, err := s.ListDocsByThread(ctx, hexThread, 100)
		if err != nil {
			t.Fatalf("ListDocsByThread: %v", err)
		}
		if len(docs) != 1 || docs[0].Content != "in-A" || docs[0].ThreadID != hexThread {
			t.Fatalf("thread-A query = %+v, want exactly the in-A message scoped to thread A", docs)
		}
	})

	t.Run("list_recent_returns_chat_messages", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.InsertMany(ctx, hexThread, hexAgentA, hexUser,
			[]llm.ChatMessage{{Role: "user", Content: "q"}}); err != nil {
			t.Fatalf("InsertMany: %v", err)
		}
		recent, err := s.ListRecentByThread(ctx, hexThread, 100)
		if err != nil {
			t.Fatalf("ListRecentByThread: %v", err)
		}
		if len(recent) != 1 || recent[0].Content != "q" {
			t.Fatalf("recent = %+v, want one message with content q", recent)
		}
	})

	t.Run("newest_window_is_returned_chronologically", func(t *testing.T) {
		s := newStore(t)
		batch := make([]llm.ChatMessage, 5)
		for i := range batch {
			batch[i] = llm.ChatMessage{Role: "user", Content: fmt.Sprintf("m%d", i)}
		}
		if _, err := s.InsertMany(ctx, hexThread, hexAgentA, hexUser, batch); err != nil {
			t.Fatalf("InsertMany: %v", err)
		}
		docs, err := s.ListDocsByThread(ctx, hexThread, 2)
		if err != nil {
			t.Fatalf("ListDocsByThread: %v", err)
		}
		if len(docs) != 2 || docs[0].Content != "m3" || docs[1].Content != "m4" {
			t.Fatalf("newest window = %+v, want [m3, m4]", docs)
		}
	})

	t.Run("tool_calls_and_metadata_roundtrip", func(t *testing.T) {
		s := newStore(t)
		message := llm.ChatMessage{
			Role: "assistant", Content: "calling", ToolCallID: "parent-call",
			ToolCalls: []llm.ToolCall{{ID: "call-1", Name: "calculator", Arguments: json.RawMessage(`{"x":2}`)}},
			Metadata:  map[string]any{"tool_name": "calculator", "is_error": false, "source": "conformance"},
		}
		inserted, err := s.InsertMany(ctx, hexThread, hexAgentA, hexUser, []llm.ChatMessage{message})
		if err != nil {
			t.Fatalf("InsertMany: %v", err)
		}
		if len(inserted) != 1 || inserted[0].ToolName != "calculator" {
			t.Fatalf("inserted record = %+v", inserted)
		}
		docs, err := s.ListDocsByThread(ctx, hexThread, 1)
		if err != nil {
			t.Fatalf("ListDocsByThread: %v", err)
		}
		if len(docs) != 1 || docs[0].ToolCallID != "parent-call" || docs[0].ToolName != "calculator" ||
			len(docs[0].ToolCalls) != 1 || docs[0].ToolCalls[0].ID != "call-1" || docs[0].ToolCalls[0].Name != "calculator" ||
			string(docs[0].ToolCalls[0].Arguments) != `{"x":2}` || docs[0].Metadata["source"] != "conformance" || docs[0].Metadata["is_error"] != false {
			t.Fatalf("complete message round-trip mismatch: %+v", docs)
		}
	})
}
