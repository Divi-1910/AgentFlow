package dispatcher

import (
	"context"
	"errors"
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
	_, err := iv.InvokeDelegate(context.Background(), parentInfo(5, "a"), "agent-b", "task")
	if !errors.Is(err, ErrDelegationDepthExceeded) {
		t.Fatalf("got %v, want ErrDelegationDepthExceeded", err)
	}
}

func TestInvoker_CycleGuard(t *testing.T) {
	t.Parallel()
	iv := NewBusDelegateInvoker(BusDelegateInvokerConfig{MaxDepth: 5})
	_, err := iv.InvokeDelegate(context.Background(), parentInfo(1, "agent-a", "agent-b"), "agent-a", "task")
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
	_, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-a"), "agent-b", "task")
	if !errors.Is(err, ErrDelegateNotOwned) {
		t.Fatalf("got %v, want ErrDelegateNotOwned", err)
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
	out, err := iv.InvokeDelegate(context.Background(), parentInfo(0, "agent-parent"), testAgentID, "find X")
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
	if _, err := iv.InvokeDelegate(ctx, parentInfo(0, "agent-parent"), testAgentID, "task"); err == nil {
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
		_, err := iv.InvokeDelegate(ctx, parentInfo(0, "agent-parent"), testAgentID, "task")
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
