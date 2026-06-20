// Package conformancetest holds backend-agnostic conformance suites that pin the
// OBSERVABLE behavior of each storage port — the atomicity, idempotency, and
// monotonicity guarantees that method signatures alone do not capture.
//
// Each suite is a Run*Conformance(t, factory) function: the factory returns a
// fresh, ready-to-use store (indexes ensured, collection isolated) per call, so
// the suite is independent of any concrete backend. Today the Mongo repositories
// are wired to these suites (see repository/conformance_test.go); when the
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
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"backend/agent"
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

// RunCheckpointConformance pins agent.CheckpointStore: status transitions are an
// atomic compare-and-set, attempt counting is monotonic, and LoadLatest returns
// the highest-step snapshot (not merely the last written).
func RunCheckpointConformance(t *testing.T, newStore func(t *testing.T) agent.CheckpointStore) {
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
}

// ── Memory revisions ────────────────────────────────────────────────────────

// RunMemoryRevisionConformance pins memory.RevisionStore.Append: it is idempotent
// by mutation_id (a replay returns the existing revision, not a duplicate) and
// rejects the same mutation_id reused across a different lineage.
func RunMemoryRevisionConformance(t *testing.T, newStore func(t *testing.T) memory.RevisionStore) {
	ctx := context.Background()
	now := time.Now()

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
}

// ── Thread (thin round-trip) ────────────────────────────────────────────────

// ThreadStore is the thread persistence port (consumer-defined here).
type ThreadStore interface {
	Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error)
	GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error)
	ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error)
	UpdateSummary(ctx context.Context, threadID, userID, summary string) error
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
}
