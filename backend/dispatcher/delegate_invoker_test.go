package dispatcher

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/llm"
	"backend/model"
	"backend/runtimectx"
)

// errAgentStore reports every agent as not-owned.
type errAgentStore struct{ *fakeAgentStore }

func (errAgentStore) GetByID(context.Context, string, string) (*agent.Agent, error) {
	return nil, errors.New("not found")
}

// capturingMessageStore records InsertMany calls so persistence can be asserted.
type capturingMessageStore struct {
	mu       sync.Mutex
	threadID string
	msgs     []llm.ChatMessage
}

func (c *capturingMessageStore) ListRecentByThread(context.Context, string, int) ([]llm.ChatMessage, error) {
	return nil, nil
}
func (c *capturingMessageStore) InsertMany(_ context.Context, threadID, _, _ string, msgs []llm.ChatMessage) ([]model.MessageDocument, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.threadID = threadID
	c.msgs = append(c.msgs, msgs...)
	return nil, nil
}
func (c *capturingMessageStore) ListDocsByThread(context.Context, string, int) ([]model.MessageDocument, error) {
	return nil, nil
}

func parentInfo(depth int, chain ...string) runtimectx.DelegationInfo {
	return runtimectx.DelegationInfo{
		OriginatorRunID: "orig-1",
		RunID:           "run-a",
		Chain:           chain,
		Depth:           depth,
		UserID:          testUserID,
	}
}

func TestInvoker_DepthGuard(t *testing.T) {
	t.Parallel()
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{MaxDepth: 5})
	_, err := iv.InvokeDelegate(context.Background(), parentInfo(5, "a"), "agent-b", "task", "tool-depth")
	if !errors.Is(err, ErrDelegationDepthExceeded) {
		t.Fatalf("got %v, want ErrDelegationDepthExceeded", err)
	}
}

func TestInvoker_CycleGuard(t *testing.T) {
	t.Parallel()
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{MaxDepth: 5})
	_, err := iv.InvokeDelegate(context.Background(), parentInfo(1, "agent-a", "agent-b"), "agent-a", "task", "tool-cycle")
	if !errors.Is(err, ErrDelegationCycle) {
		t.Fatalf("got %v, want ErrDelegationCycle", err)
	}
}

func TestInvoker_OwnershipGuard(t *testing.T) {
	t.Parallel()
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		MaxDepth: 5,
		Agents:   errAgentStore{&fakeAgentStore{}},
	})
	_, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-a"), "agent-b", "task", "tool-owned")
	if !errors.Is(err, ErrDelegateNotOwned) {
		t.Fatalf("got %v, want ErrDelegateNotOwned", err)
	}
}

func TestInvoker_BudgetExhaustedPreventsChildRun(t *testing.T) {
	t.Parallel()

	threads := &countingThreadStore{fakeThreadStore: &fakeThreadStore{thread: testThreadDoc()}}
	runs := &statusRecordingRunStore{fakeRunStore: &fakeRunStore{}}
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		Agents:  &fakeAgentStore{agent: &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}},
		Threads: threads,
		Runs:    runs,
		Tasks: &fakeBudgetStore{status: agent.RunBudgetStatus{
			OriginatorRunID: "orig-1",
			MaxRuns:         1,
			RunsUsed:        1,
			Exhausted:       true,
		}},
		MaxDepth: 5,
	})

	_, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-parent"), testAgentID, "task", "tool-budget")
	var budgetErr agent.RunBudgetError
	if !errors.As(err, &budgetErr) {
		t.Fatalf("InvokeDelegate error = %v, want RunBudgetError", err)
	}
	if threads.calls != 0 {
		t.Fatalf("FindOrCreateSubThread calls = %d, want 0", threads.calls)
	}
	if runs.childID != "" {
		t.Fatalf("child run was created despite exhausted budget: %s", runs.childID)
	}
}

func TestInvoker_ConsumesBudgetBeforeChildRun(t *testing.T) {
	t.Parallel()

	budget := &fakeBudgetStore{status: agent.RunBudgetStatus{
		OriginatorRunID: "orig-1",
		MaxRuns:         2,
		RunsUsed:        0,
	}}
	runs := &failingCreateRunStore{fakeRunStore: &fakeRunStore{}}
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		Agents:   &fakeAgentStore{agent: &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}},
		Threads:  &fakeThreadStore{thread: testThreadDoc()},
		Runs:     runs,
		Tasks:    budget,
		MaxDepth: 5,
	})

	_, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-parent"), testAgentID, "task", "tool-1")
	if err == nil {
		t.Fatal("InvokeDelegate error = nil, want create-run failure")
	}
	if budget.consumeCalls != 1 {
		t.Fatalf("budget consume calls = %d, want 1", budget.consumeCalls)
	}
	if budget.lastKey != "sync:run-a:tool-1" {
		t.Fatalf("budget key = %q, want stable parent/tool-call key", budget.lastKey)
	}
	if runs.childID == "" {
		t.Fatal("child run was not attempted after budget consumption")
	}
}

func TestInvoker_ReplayedToolCallDoesNotConsumeBudgetTwice(t *testing.T) {
	t.Parallel()

	budget := &fakeBudgetStore{status: agent.RunBudgetStatus{
		OriginatorRunID: "orig-1",
		MaxRuns:         1,
		RunsUsed:        0,
	}}
	runs := &failingCreateRunStore{fakeRunStore: &fakeRunStore{}}
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		Agents:   &fakeAgentStore{agent: &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}},
		Threads:  &fakeThreadStore{thread: testThreadDoc()},
		Runs:     runs,
		Tasks:    budget,
		MaxDepth: 5,
	})

	for i := 0; i < 2; i++ {
		_, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-parent"), testAgentID, "task", "same-tool-call")
		if err == nil || !strings.Contains(err.Error(), "create failed") {
			t.Fatalf("attempt %d error = %v, want create failed after budget admission", i+1, err)
		}
		var budgetErr agent.RunBudgetError
		if errors.As(err, &budgetErr) {
			t.Fatalf("attempt %d returned budget error on replay: %v", i+1, err)
		}
	}
	if budget.status.RunsUsed != 1 {
		t.Fatalf("RunsUsed = %d, want replay to keep it at 1", budget.status.RunsUsed)
	}
	if budget.consumeCalls != 2 {
		t.Fatalf("consume calls = %d, want two idempotent consume attempts", budget.consumeCalls)
	}
	if runs.createCalls != 2 {
		t.Fatalf("child run attempts = %d, want replay admitted twice with same charged key", runs.createCalls)
	}
}

func TestInvoker_HappyPathDispatchesPersistsAndReturns(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })

	rt := &fakeRuntime{} // default fake replies "ok"
	preparer := newTestPreparer(rt)
	pools := NewPoolManager(PoolManagerConfig{RootCtx: context.Background(), Bus: b, Preparer: preparer, Runtime: rt, Workers: 1})
	t.Cleanup(pools.StopAll)

	agentObj := &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}
	msgs := &capturingMessageStore{}
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		Bus:           b,
		Pools:         pools,
		Agents:        &fakeAgentStore{agent: agentObj},
		Threads:       &fakeThreadStore{thread: testThreadDoc()},
		Runs:          &fakeRunStore{snapshot: validSnapshot()},
		Messages:      msgs,
		MaxDepth:      5,
		SafetyTimeout: 5 * time.Second,
	})

	// Delegate to testAgentID (matches the fake sub-thread's agent so the
	// worker's prepareFresh ownership check passes).
	out, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-parent"), testAgentID, "find X", "tool-happy")
	if err != nil {
		t.Fatalf("InvokeDelegate: %v", err)
	}
	if out != "ok" {
		t.Fatalf("output = %q, want ok", out)
	}

	// The task must be persisted as a user message to the sub-thread, plus the
	// delegate's NewMessages.
	msgs.mu.Lock()
	defer msgs.mu.Unlock()
	if len(msgs.msgs) == 0 {
		t.Fatal("nothing persisted to sub-thread")
	}
	first := msgs.msgs[0]
	if first.Role != "user" || first.Content != "find X" {
		t.Fatalf("first persisted message = %+v, want user/find X", first)
	}
	if first.Metadata["target_agent_id"] != testAgentID {
		t.Fatalf("missing/incorrect target_agent_id metadata: %+v", first.Metadata)
	}
}

// statusRecordingRunStore records the created child-run ID and every status
// written for it, so tests can assert who finalized the run (or that no one
// did).
type statusRecordingRunStore struct {
	*fakeRunStore
	mu       sync.Mutex
	childID  string
	statuses []string
}

func (s *statusRecordingRunStore) CreateChildRun(_ context.Context, runID, _, _, _, _, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.childID = runID
	return nil
}

func (s *statusRecordingRunStore) UpdateStatus(_ context.Context, runID, status, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if runID == s.childID {
		s.statuses = append(s.statuses, status)
	}
	return nil
}

type failingCreateRunStore struct {
	*fakeRunStore
	childID     string
	createCalls int
}

func (s *failingCreateRunStore) CreateChildRun(_ context.Context, runID, _, _, _, _, _ string) error {
	s.childID = runID
	s.createCalls++
	return errors.New("create failed")
}

type countingThreadStore struct {
	*fakeThreadStore
	calls int
}

func (s *countingThreadStore) FindOrCreateSubThread(ctx context.Context, userID, originatorRunID, agentID string) (string, error) {
	s.calls++
	return s.fakeThreadStore.FindOrCreateSubThread(ctx, userID, originatorRunID, agentID)
}

type fakeBudgetStore struct {
	status       agent.RunBudgetStatus
	ensureCalls  int
	ensureMax    int
	consumeOK    bool
	consumeCalls int
	lastKey      string
	seen         map[string]bool
}

func (s *fakeBudgetStore) EnsureTask(_ context.Context, _ string, _ string, maxRuns int) error {
	s.ensureCalls++
	s.ensureMax = maxRuns
	return nil
}

func (s *fakeBudgetStore) BudgetStatus(context.Context, string) (agent.RunBudgetStatus, error) {
	return s.status, nil
}

func (s *fakeBudgetStore) TryConsumeRun(_ context.Context, _ string, _ string, key string) (agent.RunBudgetStatus, bool, error) {
	s.consumeCalls++
	s.lastKey = key
	if s.seen == nil {
		s.seen = make(map[string]bool)
	}
	if s.seen[key] {
		return s.status, true, nil
	}
	if s.consumeOK || !s.status.Exhausted {
		s.seen[key] = true
		s.status.RunsUsed++
		if s.status.RunsUsed >= s.status.MaxRuns {
			s.status.Exhausted = true
		}
		return s.status, true, nil
	}
	return s.status, false, nil
}

// A caller ctx that dies before the dispatch is published must not strand the
// child run in "running": the invoker is the only party that can finalize a
// never-dispatched run, and it must mark it failed.
func TestInvoker_PreCancelledCtxFinalizesUndispatchedChild(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })
	rt := &fakeRuntime{}
	pools := NewPoolManager(PoolManagerConfig{RootCtx: context.Background(), Bus: b, Preparer: newTestPreparer(rt), Runtime: rt, Workers: 1})
	t.Cleanup(pools.StopAll)

	store := &statusRecordingRunStore{fakeRunStore: &fakeRunStore{}}
	agentObj := &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		Bus:           b,
		Pools:         pools,
		Agents:        &fakeAgentStore{agent: agentObj},
		Threads:       &fakeThreadStore{thread: testThreadDoc()},
		Runs:          store,
		MaxDepth:      5,
		SafetyTimeout: 5 * time.Second,
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := iv.InvokeDelegate(ctx, parentInfo(0, "agent-parent"), testAgentID, "task", "tool-precancel"); err == nil {
		t.Fatal("want error from pre-cancelled ctx")
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.childID == "" {
		t.Fatal("child run was never created")
	}
	if len(store.statuses) != 1 || store.statuses[0] != "failed" {
		t.Fatalf("child statuses = %v, want exactly [failed] (invoker finalizes undispatched child)", store.statuses)
	}
}

// Once the dispatch reaches a worker, the invoker must return promptly when
// the caller's ctx dies — and must NOT write the child run's status, which the
// worker/runtime own from that point.
func TestInvoker_CallerCancelAfterDispatchLeavesStatusToWorker(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })

	started := make(chan struct{})
	release := make(chan struct{})
	rt := &fakeRuntime{runFn: func(ctx context.Context, _ *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
		close(events)
		close(started)
		select {
		case <-release:
			return &agent.RunResult{Output: "late"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	pools := NewPoolManager(PoolManagerConfig{RootCtx: context.Background(), Bus: b, Preparer: newTestPreparer(rt), Runtime: rt, Workers: 1})
	t.Cleanup(pools.StopAll)
	defer close(release)

	store := &statusRecordingRunStore{fakeRunStore: &fakeRunStore{}}
	agentObj := &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{
		Bus:           b,
		Pools:         pools,
		Agents:        &fakeAgentStore{agent: agentObj},
		Threads:       &fakeThreadStore{thread: testThreadDoc()},
		Runs:          store,
		MaxDepth:      5,
		SafetyTimeout: 30 * time.Second,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		_, err := iv.InvokeDelegate(ctx, parentInfo(0, "agent-parent"), testAgentID, "task", "tool-cancel")
		errCh <- err
	}()

	<-started // the worker has the dispatch and is inside RunStream
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("InvokeDelegate did not return promptly after caller cancel")
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.statuses) != 0 {
		t.Fatalf("invoker wrote child statuses %v; post-dispatch status is worker-owned", store.statuses)
	}
}

func testThreadDoc() *model.ThreadDocument {
	// Reuse the preparer's thread shape so prepareFresh's agent-ownership
	// check passes when the delegate target is testAgentID.
	preparer := newTestPreparer(&fakeRuntime{})
	doc, _ := preparer.threads.GetByID(context.Background(), testThreadID, testUserID)
	return doc
}
