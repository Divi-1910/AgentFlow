package sqliterepo_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/dispatcher"
	"backend/llm"
	"backend/model"
	"backend/repo/sqliterepo"
)

// asyncDelegationLLM serves both the supervisor and worker agents in the
// required-job round trip. It distinguishes turns by content: once a
// tool-role message is present (the delivered await result), the required
// job has resolved and it's time to produce the final answer.
type asyncDelegationLLM struct{ workerOutput string }

func (f *asyncDelegationLLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	if req.Model == "worker" {
		return &llm.ChatResponse{Content: f.workerOutput, Model: req.Model}, nil
	}
	for _, m := range req.Messages {
		if m.Role == "tool" {
			return &llm.ChatResponse{Content: "supervisor final answer", Model: req.Model}, nil
		}
	}
	args, _ := json.Marshal(map[string]string{
		"delegate_tool": "ask_worker", "task": "do the async work", "mode": agent.JobModeRequired,
	})
	return &llm.ChatResponse{
		Model:     req.Model,
		ToolCalls: []llm.ToolCall{{ID: "dispatch-call", Name: agent.AsyncToolDispatchAgent, Arguments: args}},
	}, nil
}

// asyncBackgroundLLM serves the background-dispatch round trip. The
// supervisor's first turn dispatches a background job and immediately
// answers — background mode never suspends the dispatching run — recognized
// by a tool-role message (the immediate dispatch result, not an await). Its
// LATER callback turn is a fresh run recognized by the injected
// system_context, since callbackSystemContext's text ends up in the
// rendered system prompt among req.Messages.
type asyncBackgroundLLM struct{ workerOutput string }

func (f *asyncBackgroundLLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	if req.Model == "worker" {
		return &llm.ChatResponse{Content: f.workerOutput, Model: req.Model}, nil
	}
	for _, m := range req.Messages {
		if strings.Contains(m.Content, "background task you started earlier") {
			return &llm.ChatResponse{Content: "callback acknowledged", Model: req.Model}, nil
		}
	}
	for _, m := range req.Messages {
		if m.Role == "tool" {
			return &llm.ChatResponse{Content: "started the background task", Model: req.Model}, nil
		}
	}
	args, _ := json.Marshal(map[string]string{
		"delegate_tool": "ask_worker", "task": "do the background work",
		"mode": agent.JobModeBackground, "callback_instruction": "tell the user when done",
	})
	return &llm.ChatResponse{
		Model:     req.Model,
		ToolCalls: []llm.ToolCall{{ID: "dispatch-bg-call", Name: agent.AsyncToolDispatchAgent, Arguments: args}},
	}, nil
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !cond() {
		t.Fatal("condition not met before timeout")
	}
}

// asyncHarness wires the full async stack against a real SQLite file: job
// store, task budget/cancel store, a real bus, a JobCoordinator on a fast
// tick (so tests don't wait on the 1s production default), and a
// DirectDispatcher for the top-level run. The coordinator is built but NOT
// started — callers that need to observe or manipulate a job's state before
// any coordinator processing (cancellation, simulated stuck claims, or a
// close-before-claim durability proof) must control exactly when it starts
// ticking, or a fast tick can race ahead of the test's own setup.
type asyncHarness struct {
	db          *sql.DB
	runs        *sqliterepo.RunRepo
	threads     *sqliterepo.ThreadRepo
	messages    *sqliterepo.MessageRepo
	tasks       *sqliterepo.TaskRepo
	jobs        *sqliterepo.JobRepo
	direct      *dispatcher.DirectDispatcher
	coordinator *dispatcher.JobCoordinator
	rootCtx     context.Context
	stop        func()
}

func (h *asyncHarness) startCoordinator() {
	h.coordinator.Start(h.rootCtx)
}

func newAsyncHarness(t *testing.T, dbPath string, client llm.LLMClient, reader dispatcher.AgentReader) *asyncHarness {
	t.Helper()
	db, err := sqliterepo.Open(dbPath, sqliterepo.Options{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	runs := sqliterepo.NewRunRepo(db)
	threads := sqliterepo.NewThreadRepo(db)
	messages := sqliterepo.NewMessageRepo(db)
	tasks := sqliterepo.NewTaskRepo(db)
	jobs := sqliterepo.NewJobRepo(db)
	jobs.SetTaskBudgetStore(tasks)

	runtime, toolRegistry := testRuntime(t, client, runs, agent.ToolCapabilities{AsyncJobs: true})
	runtime.SetAsyncJobStore(jobs)

	rootCtx, stopRoot := context.WithCancel(context.Background())
	theBus := bus.NewInProc()
	jobHub := dispatcher.NewJobHub()
	preparer := dispatcher.NewRunPreparer(dispatcher.RunPreparerConfig{
		Agents: reader, Threads: threads, Messages: messages, Runs: runs,
		Runtime: runtime, ToolRegistry: toolRegistry, Tasks: tasks,
		Background: rootCtx, Capabilities: agent.ToolCapabilities{AsyncJobs: true},
	})
	pools := dispatcher.NewPoolManager(dispatcher.PoolManagerConfig{
		RootCtx: rootCtx, Bus: theBus, Preparer: preparer, Runtime: runtime,
		Status: runs, Messages: messages, Jobs: jobs, Tasks: tasks, Hub: jobHub, Workers: 2,
	})
	invoker := dispatcher.NewBusDelegateInvoker(dispatcher.BusDelegateInvokerConfig{
		Bus: theBus, Pools: pools, Agents: reader, Threads: threads, Runs: runs,
		Messages: messages, Tasks: tasks, SafetyTimeout: 5 * time.Second,
	})
	runtime.SetDelegateInvoker(invoker)

	coordinator := dispatcher.NewJobCoordinator(dispatcher.JobCoordinatorConfig{
		Bus: theBus, Pools: pools, Threads: threads, Runs: runs, Jobs: jobs, Tasks: tasks, Hub: jobHub,
		WorkerID:          "test-coordinator",
		ConcurrentJobs:    5,
		JobLease:          500 * time.Millisecond,
		JobLockLease:      500 * time.Millisecond,
		CallbackLockLease: 500 * time.Millisecond,
		ReclaimGrace:      50 * time.Millisecond,
		Tick:              20 * time.Millisecond,
	})

	direct := &dispatcher.DirectDispatcher{Preparer: preparer, Runtime: runtime, Bus: theBus, Pools: pools}

	// stop must actually close db, not just the bus/pools/context, so a test
	// that explicitly stops phase 1 before reopening the same path proves a
	// real close-discard-reopen cycle rather than a second connection
	// tolerating an idle first one. sync.Once makes it safe to call both
	// explicitly (mid-test) and via t.Cleanup (end of test) without erroring
	// on a double-stop.
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			stopRoot()
			pools.StopAll()
			_ = theBus.Close()
			_ = db.Close()
		})
	}
	t.Cleanup(stop)

	return &asyncHarness{
		db: db, runs: runs, threads: threads, messages: messages, tasks: tasks, jobs: jobs,
		direct: direct, coordinator: coordinator, rootCtx: rootCtx, stop: stop,
	}
}

func asyncAgents(userID string) (*agent.Agent, *mapAgentReader) {
	supervisor := &agent.Agent{
		ID: "supervisor", Provider: "fake", Model: "supervisor", SystemPrompt: "supervise", MaxSteps: 4, MaxRuns: 3,
		Delegates: []agent.DelegateConfig{{AgentID: "worker", ToolName: "ask_worker", Description: "ask worker"}},
	}
	worker := &agent.Agent{ID: "worker", Provider: "fake", Model: "worker", SystemPrompt: "work", MaxSteps: 2}
	reader := &mapAgentReader{userID: userID, agents: map[string]*agent.Agent{supervisor.ID: supervisor, worker.ID: worker}}
	return supervisor, reader
}

func containsMessage(msgs []agent.MessageRecord, role, substr string) bool {
	for _, m := range msgs {
		if m.Role == role && strings.Contains(m.Content, substr) {
			return true
		}
	}
	return false
}

// TestAsyncRequiredJobDispatchResumesAcrossReopen proves the primary async
// cycle survives a restart: dispatch a required job, suspend, close the DB
// before the coordinator ever claims it (the coordinator is never started in
// phase 1), reopen from disk, start a brand new coordinator, and let it
// discover and complete the queued job on its own — same durability bar as
// the sync smoke test.
func TestAsyncRequiredJobDispatchResumesAcrossReopen(t *testing.T) {
	path := t.TempDir() + "/async_required.db"
	ctx := context.Background()
	userID := "user-1"
	topRunID := "top-run"
	supervisor, reader := asyncAgents(userID)

	func() {
		h := newAsyncHarness(t, path, &asyncDelegationLLM{workerOutput: "async work result"}, reader)
		defer h.stop()

		topThread, err := h.threads.Create(ctx, userID, supervisor.ID, "async delegation")
		if err != nil {
			t.Fatalf("Create top thread: %v", err)
		}
		if _, err := h.messages.InsertMany(ctx, topThread.ID, supervisor.ID, userID, []llm.ChatMessage{{Role: "user", Content: "please delegate"}}); err != nil {
			t.Fatalf("insert top message: %v", err)
		}
		if err := h.runs.CreateRun(ctx, topRunID, topThread.ID, supervisor.ID, userID); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}

		dispatchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		events := make(chan agent.StreamEvent, 128)
		result, err := h.direct.Dispatch(dispatchCtx, dispatcher.DispatchRequest{
			RunID: topRunID, AgentID: supervisor.ID, UserID: userID, ThreadID: topThread.ID, Input: "please delegate",
		}, events)
		if err != nil {
			t.Fatalf("initial dispatch: %v", err)
		}
		if result.Status != agent.RunResultWaiting {
			t.Fatalf("initial dispatch status = %q, want %q", result.Status, agent.RunResultWaiting)
		}
		info, err := h.runs.GetRun(ctx, topRunID)
		if err != nil || info.Status != string(model.RunStatusWaitingJobs) {
			t.Fatalf("run after suspend = %+v, err=%v, want waiting_for_jobs", info, err)
		}
		pending, err := h.jobs.PendingRequiredJobs(ctx, topRunID, userID)
		if err != nil || len(pending) != 1 {
			t.Fatalf("PendingRequiredJobs before close = %+v, err=%v, want exactly one queued job", pending, err)
		}
		// The coordinator was never started in this phase: the job is still
		// queued and the run still waiting when we close.
	}()

	h2 := newAsyncHarness(t, path, &asyncDelegationLLM{workerOutput: "async work result"}, reader)
	defer h2.stop()
	h2.startCoordinator()

	waitFor(t, 5*time.Second, func() bool {
		info, err := h2.runs.GetRun(ctx, topRunID)
		if err != nil || info.Status != string(model.RunStatusCompleted) {
			return false
		}
		persisted, err := h2.messages.ListDocsByThread(ctx, info.ThreadID, 20)
		return err == nil && containsMessage(persisted, "assistant", "supervisor final answer")
	})

	final, err := h2.runs.GetRun(ctx, topRunID)
	if err != nil || final.Status != string(model.RunStatusCompleted) {
		t.Fatalf("final run state = %+v, err=%v", final, err)
	}
	status, err := h2.tasks.BudgetStatus(ctx, topRunID)
	if err != nil || status.RunsUsed != 1 {
		t.Fatalf("budget after one async dispatch = %+v, err=%v, want RunsUsed=1", status, err)
	}
}

// TestAsyncBackgroundJobDispatchTriggersCallback proves the background path:
// dispatching does not suspend the caller, the job runs to completion in the
// background, and the coordinator then dispatches a callback run appending
// its answer to the SAME top-level thread ("continuing the earlier
// conversation").
func TestAsyncBackgroundJobDispatchTriggersCallback(t *testing.T) {
	path := t.TempDir() + "/async_background.db"
	ctx := context.Background()
	userID := "user-1"
	topRunID := "bg-top-run"
	supervisor, reader := asyncAgents(userID)

	h := newAsyncHarness(t, path, &asyncBackgroundLLM{workerOutput: "background work result"}, reader)
	defer h.stop()
	h.startCoordinator()

	topThread, err := h.threads.Create(ctx, userID, supervisor.ID, "async background")
	if err != nil {
		t.Fatalf("Create top thread: %v", err)
	}
	if _, err := h.messages.InsertMany(ctx, topThread.ID, supervisor.ID, userID, []llm.ChatMessage{{Role: "user", Content: "start background work"}}); err != nil {
		t.Fatalf("insert top message: %v", err)
	}
	if err := h.runs.CreateRun(ctx, topRunID, topThread.ID, supervisor.ID, userID); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	dispatchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	events := make(chan agent.StreamEvent, 128)
	result, err := h.direct.Dispatch(dispatchCtx, dispatcher.DispatchRequest{
		RunID: topRunID, AgentID: supervisor.ID, UserID: userID, ThreadID: topThread.ID, Input: "start background work",
	}, events)
	if err != nil {
		t.Fatalf("initial dispatch: %v", err)
	}
	if result.Status != agent.RunResultCompleted {
		t.Fatalf("initial dispatch status = %q, want %q (background must not suspend)", result.Status, agent.RunResultCompleted)
	}

	// Poll for the callback's persisted answer directly, not just the
	// callback run's status: the run's terminal status is written by the
	// runtime before AgentPool.afterRun persists its messages, so checking
	// status alone races ahead of persistence.
	waitFor(t, 5*time.Second, func() bool {
		persisted, err := h.messages.ListDocsByThread(ctx, topThread.ID, 20)
		return err == nil && containsMessage(persisted, "assistant", "callback acknowledged")
	})
}

// TestAsyncCoordinatorCancelsQueuedJobBeforeClaim proves cancellation: the
// originator is cancelled before the coordinator ever claims the queued
// required job (the coordinator only starts ticking after cancellation), so
// the job is marked cancelled — never dispatched, never run — and the
// waiting supervisor run is itself transitioned to cancelled once the
// coordinator observes its only awaited job is (terminally) cancelled.
func TestAsyncCoordinatorCancelsQueuedJobBeforeClaim(t *testing.T) {
	path := t.TempDir() + "/async_cancel.db"
	ctx := context.Background()
	userID := "user-1"
	topRunID := "cancel-top-run"
	supervisor, reader := asyncAgents(userID)

	h := newAsyncHarness(t, path, &asyncDelegationLLM{workerOutput: "should never run"}, reader)
	defer h.stop()

	topThread, err := h.threads.Create(ctx, userID, supervisor.ID, "cancel test")
	if err != nil {
		t.Fatalf("Create top thread: %v", err)
	}
	if _, err := h.messages.InsertMany(ctx, topThread.ID, supervisor.ID, userID, []llm.ChatMessage{{Role: "user", Content: "go"}}); err != nil {
		t.Fatalf("insert message: %v", err)
	}
	if err := h.runs.CreateRun(ctx, topRunID, topThread.ID, supervisor.ID, userID); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	dispatchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	events := make(chan agent.StreamEvent, 128)
	result, err := h.direct.Dispatch(dispatchCtx, dispatcher.DispatchRequest{
		RunID: topRunID, AgentID: supervisor.ID, UserID: userID, ThreadID: topThread.ID, Input: "go",
	}, events)
	if err != nil || result.Status != agent.RunResultWaiting {
		t.Fatalf("initial dispatch: result=%+v err=%v", result, err)
	}

	pending, err := h.jobs.PendingRequiredJobs(ctx, topRunID, userID)
	if err != nil || len(pending) != 1 {
		t.Fatalf("PendingRequiredJobs: %+v, err=%v", pending, err)
	}
	jobID := pending[0].JobID

	if err := h.tasks.CancelTask(ctx, topRunID, "test cancel"); err != nil {
		t.Fatalf("CancelTask: %v", err)
	}
	// Only now let the coordinator run — proving it observes cancellation
	// rather than racing to claim the job first.
	h.startCoordinator()

	waitFor(t, 5*time.Second, func() bool {
		info, err := h.runs.GetRun(ctx, topRunID)
		return err == nil && info.Status == string(model.RunStatusCancelled)
	})

	res, err := h.jobs.AwaitJob(ctx, agent.AwaitJobRequest{JobID: jobID, UserID: userID, OriginatorRunID: topRunID})
	if err != nil || res.Pending || res.Status != string(agent.JobStatusCancelled) {
		t.Fatalf("job after cancellation = %+v, err=%v, want terminal cancelled", res, err)
	}
}

// TestAsyncCoordinatorReclaimsExpiredStartingJob proves lock/lease recovery
// at the coordinator level: a job stuck in "starting" under an
// immediately-expired lease (simulating a coordinator that claimed it then
// crashed before dispatching — the real coordinator isn't started until
// after this is simulated) is reclaimed and driven to completion by a fresh,
// real coordinator — not just proven at the repo layer in isolation.
func TestAsyncCoordinatorReclaimsExpiredStartingJob(t *testing.T) {
	path := t.TempDir() + "/async_reclaim.db"
	ctx := context.Background()
	userID := "user-1"
	topRunID := "reclaim-top-run"
	supervisor, reader := asyncAgents(userID)

	h := newAsyncHarness(t, path, &asyncDelegationLLM{workerOutput: "reclaimed work result"}, reader)
	defer h.stop()

	topThread, err := h.threads.Create(ctx, userID, supervisor.ID, "reclaim test")
	if err != nil {
		t.Fatalf("Create top thread: %v", err)
	}
	if _, err := h.messages.InsertMany(ctx, topThread.ID, supervisor.ID, userID, []llm.ChatMessage{{Role: "user", Content: "go"}}); err != nil {
		t.Fatalf("insert message: %v", err)
	}
	if err := h.runs.CreateRun(ctx, topRunID, topThread.ID, supervisor.ID, userID); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	dispatchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	events := make(chan agent.StreamEvent, 128)
	result, err := h.direct.Dispatch(dispatchCtx, dispatcher.DispatchRequest{
		RunID: topRunID, AgentID: supervisor.ID, UserID: userID, ThreadID: topThread.ID, Input: "go",
	}, events)
	if err != nil || result.Status != agent.RunResultWaiting {
		t.Fatalf("initial dispatch: result=%+v err=%v", result, err)
	}

	pending, err := h.jobs.PendingRequiredJobs(ctx, topRunID, userID)
	if err != nil || len(pending) != 1 {
		t.Fatalf("PendingRequiredJobs: %+v, err=%v", pending, err)
	}
	jobID := pending[0].JobID

	if _, ok, err := h.jobs.ClaimJobStarting(ctx, jobID, "dead-coordinator", -time.Millisecond); err != nil || !ok {
		t.Fatalf("simulate stuck claim: ok=%v err=%v", ok, err)
	}
	// Only now let the real coordinator run — proving it discovers and
	// reclaims a job that got stuck before it ever started.
	h.startCoordinator()

	waitFor(t, 5*time.Second, func() bool {
		info, err := h.runs.GetRun(ctx, topRunID)
		return err == nil && info.Status == string(model.RunStatusCompleted)
	})
}
