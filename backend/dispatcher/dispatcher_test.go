package dispatcher

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/llm"
	"backend/model"
	"backend/repository"
	"backend/tools"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	testAgentID  = "507f1f77bcf86cd799439012"
	testThreadID = "507f1f77bcf86cd799439013"
	testUserID   = "507f1f77bcf86cd799439014"
)

func TestBusDispatcher_RoundTripForwardsEventsAndReply(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })

	rt := &fakeRuntime{}
	preparer := newTestPreparer(rt)
	pools := NewPoolManager(PoolManagerConfig{RootCtx: context.Background(), Bus: b, Preparer: preparer, Runtime: rt, Workers: 1})
	t.Cleanup(pools.StopAll)

	disp := &BusDispatcher{
		Bus:            b,
		Pools:          pools,
		Preparer:       preparer,
		RequestTimeout: time.Second,
	}

	events := make(chan agent.StreamEvent, 8)
	res, err := disp.Dispatch(context.Background(), freshDispatchRequest(), events)
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if res == nil || res.Output != "ok" {
		t.Fatalf("result = %+v, want output ok", res)
	}

	var types []agent.EventType
	for event := range events {
		types = append(types, event.Type)
	}
	if !hasEvent(types, agent.EventRunStarted) || !hasEvent(types, agent.EventRunCompleted) {
		t.Fatalf("events = %v, want started and completed", types)
	}
}

func TestBusDispatcher_ContextCancelCancelsWorkerRun(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })

	started := make(chan struct{})
	rt := &fakeRuntime{
		runFn: func(ctx context.Context, _ *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
			close(started)
			<-ctx.Done()
			events <- agent.StreamEvent{Type: agent.EventRunCancelled, RunID: runCtx.RunID, Time: time.Now()}
			close(events)
			return nil, ctx.Err()
		},
	}
	preparer := newTestPreparer(rt)
	pools := NewPoolManager(PoolManagerConfig{RootCtx: context.Background(), Bus: b, Preparer: preparer, Runtime: rt, Workers: 1})
	t.Cleanup(pools.StopAll)
	disp := &BusDispatcher{Bus: b, Pools: pools, Preparer: preparer, RequestTimeout: time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan agent.StreamEvent, 8)
	done := make(chan error, 1)
	go func() {
		_, err := disp.Dispatch(ctx, freshDispatchRequest(), events)
		done <- err
	}()

	mustClose(t, started, time.Second)
	cancel()
	err := mustReceiveErr(t, done, time.Second)
	if err == nil {
		t.Fatal("Dispatch() error = nil, want cancellation error")
	}
}

func TestAgentPool_HonorsPreCanceledTask(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })

	cancels := NewCancelRegistry(0)
	cancels.Cancel("run-1")

	// A pre-cancelled task must short-circuit BEFORE RunStream — the worker
	// owns the terminal status on this bail path, so runFn is never called.
	ranCh := make(chan struct{}, 1)
	rt := &fakeRuntime{
		runFn: func(ctx context.Context, _ *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
			ranCh <- struct{}{}
			close(events)
			return nil, ctx.Err()
		},
	}
	preparer := newTestPreparer(rt)
	status := &recordingStatusUpdater{}
	pool := NewAgentPool(context.Background(), testAgentID, b, preparer, rt, status, nil, nil, nil, nil, 1, cancels)
	if err := pool.Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(pool.Stop)

	reply, err := b.Request(context.Background(), dispatchTopic(testAgentID), mustPayloadMessage(t, freshDispatchRequest()), time.Second)
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	var dispatchReply DispatchReply
	if err := json.Unmarshal(reply.Body, &dispatchReply); err != nil {
		t.Fatalf("Unmarshal(reply) error = %v", err)
	}
	if dispatchReply.Error == "" {
		t.Fatal("reply error was empty, want cancellation reply error")
	}
	select {
	case <-ranCh:
		t.Fatal("RunStream was called for a pre-cancelled task; worker should short-circuit")
	default:
	}
	// No checkpoint exists for a run that never started, so the worker must
	// mark it failed — "interrupted" would promise a resume that can't work.
	status.mu.Lock()
	defer status.mu.Unlock()
	if len(status.statuses) != 1 || status.statuses[0] != "failed" {
		t.Fatalf("statuses = %v, want exactly [failed] for a pre-cancelled run", status.statuses)
	}
}

// recordingStatusUpdater records statuses written by the worker's bail paths.
type recordingStatusUpdater struct {
	mu       sync.Mutex
	statuses []string
}

func (r *recordingStatusUpdater) UpdateStatus(_ context.Context, _, status, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statuses = append(r.statuses, status)
	return nil
}

func TestPoolManager_EnsureIdempotentUnderConcurrency(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })
	rt := &fakeRuntime{}
	preparer := newTestPreparer(rt)
	pools := NewPoolManager(PoolManagerConfig{RootCtx: context.Background(), Bus: b, Preparer: preparer, Runtime: rt, Workers: 1})
	t.Cleanup(pools.StopAll)

	var wg sync.WaitGroup
	errCh := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := pools.Ensure(context.Background(), testAgentID); err != nil {
				errCh <- err
			}
		}()
	}
	waitGroupDone(t, &wg, time.Second)
	close(errCh)
	for err := range errCh {
		t.Fatalf("Ensure() error = %v", err)
	}
	if got := pools.PoolCount(); got != 1 {
		t.Fatalf("PoolCount() = %d, want 1", got)
	}
}

func TestRunPreparer_ResumeAppliesRequestAttempt(t *testing.T) {
	t.Parallel()

	rt := &fakeRuntime{}
	preparer := newTestPreparer(rt)
	prepared, err := preparer.Prepare(context.Background(), DispatchRequest{
		RunID:    "run-resume",
		AgentID:  testAgentID,
		UserID:   testUserID,
		IsResume: true,
		Attempt:  7,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if prepared.RunCtx.Attempt != 7 {
		t.Fatalf("RunCtx.Attempt = %d, want 7", prepared.RunCtx.Attempt)
	}
	if prepared.RunCtx.Checkpoint == nil || prepared.RunCtx.Checkpoint.Meta.Attempt != 7 {
		t.Fatalf("snapshot attempt = %+v, want 7", prepared.RunCtx.Checkpoint)
	}
}

func TestRunPreparerFreshTopLevelEnsuresTaskBudgetFromRootAgent(t *testing.T) {
	t.Parallel()

	rt := &fakeRuntime{}
	agentObj := &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5, MaxRuns: 13}
	agentOID, _ := bson.ObjectIDFromHex(testAgentID)
	threadOID, _ := bson.ObjectIDFromHex(testThreadID)
	userOID, _ := bson.ObjectIDFromHex(testUserID)
	thread := &model.ThreadDocument{ID: threadOID, AgentID: agentOID, UserID: userOID}
	tasks := &fakeBudgetStore{}
	preparer := NewRunPreparer(RunPreparerConfig{
		Agents:       &fakeAgentStore{agent: agentObj},
		Threads:      &fakeThreadStore{thread: thread},
		Messages:     &fakeMessageStore{messages: []llm.ChatMessage{{Role: "user", Content: "hello"}}},
		Runtime:      rt,
		ToolRegistry: tools.NewEmptyRegistry(),
		Tasks:        tasks,
	})

	prepared, err := preparer.Prepare(context.Background(), freshDispatchRequest())
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prepared.RunCtx.InvocationKind != agent.InvocationTopLevel {
		t.Fatalf("InvocationKind = %q, want top_level", prepared.RunCtx.InvocationKind)
	}
	if tasks.ensureCalls != 1 || tasks.ensureMax != 13 {
		t.Fatalf("EnsureTask calls/max = %d/%d, want 1/13", tasks.ensureCalls, tasks.ensureMax)
	}
}

func TestDirectDispatcher_PrepareErrorClosesEvents(t *testing.T) {
	t.Parallel()

	d := &DirectDispatcher{Preparer: &RunPreparer{}, Runtime: &fakeRuntime{}}
	events := make(chan agent.StreamEvent, 1)
	_, err := d.Dispatch(context.Background(), freshDispatchRequest(), events)
	if err == nil {
		t.Fatal("Dispatch() error = nil, want prepare error")
	}
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("events channel received message, want closed")
		}
	case <-time.After(time.Second):
		t.Fatal("events channel was not closed")
	}
}

// TestAgentPool_ForwardWorkerEventsKeepsDrainingOnPublishError pins B1.
//
// If the events-topic Publish ever fails (bus closed mid-run, ctx propagating
// into Publish, transport hiccup), the forwarder MUST keep draining
// workerEvents. Otherwise runtime.RunStream blocks on the 129th send once
// the 128-element buffer fills, the reply is never published, and the
// caller's bus.Request times out at RequestTimeout (default 10 minutes).
//
// The regression: change the forwarder's publish-error branch back to
// `return` and this test will deadlock-then-timeout.
func TestAgentPool_ForwardWorkerEventsKeepsDrainingOnPublishError(t *testing.T) {
	t.Parallel()

	pool := &AgentPool{bus: &alwaysFailPublishBus{}}

	workerEvents := make(chan agent.StreamEvent, 4)
	forwarderDone := make(chan struct{})

	go pool.forwardWorkerEvents(context.Background(), "task-fail", workerEvents, forwarderDone)

	// Send well beyond the buffer capacity. If the forwarder stops draining
	// on the first publish failure, every send past the buffer will block.
	sendDone := make(chan struct{})
	go func() {
		defer close(sendDone)
		for i := 0; i < 200; i++ {
			workerEvents <- agent.StreamEvent{Type: agent.EventStepStarted, RunID: "task-fail"}
		}
		close(workerEvents)
	}()

	select {
	case <-sendDone:
	case <-time.After(2 * time.Second):
		t.Fatal("forwarder stopped draining workerEvents — RunStream would block in production")
	}

	select {
	case <-forwarderDone:
	case <-time.After(time.Second):
		t.Fatal("forwarder did not exit after workerEvents was closed")
	}
}

// alwaysFailPublishBus satisfies bus.MessageBus and returns an error from
// every Publish call. Subscribe/Request/Close panic — those paths are not
// exercised by forwardWorkerEvents and we don't want silent test drift if
// they ever are.
type alwaysFailPublishBus struct{}

func (alwaysFailPublishBus) Publish(_ context.Context, _ string, _ bus.Message, _ ...bus.PublishOption) error {
	return errors.New("simulated publish failure")
}
func (alwaysFailPublishBus) Subscribe(_ context.Context, _ string, _ ...bus.SubscribeOption) (bus.Subscription, error) {
	panic("alwaysFailPublishBus.Subscribe not implemented for this test")
}
func (alwaysFailPublishBus) Request(_ context.Context, _ string, _ bus.Message, _ time.Duration) (bus.Message, error) {
	panic("alwaysFailPublishBus.Request not implemented for this test")
}
func (alwaysFailPublishBus) Close() error {
	panic("alwaysFailPublishBus.Close not implemented for this test")
}

// TestAgentPool_CancelDuringPrepareAbortsRun pins the mid-flight cancel window:
// a cancel published AFTER the worker subscribed to the cancel topic but
// BEFORE runtime.RunStream begins (i.e. while preparer.Prepare is running)
// must still cancel the run.
//
// The gated message store holds the worker inside Prepare so the cancel is
// published in exactly that window. The fake runtime then blocks on
// ctx.Done(), so the test only completes if the mid-Prepare cancel actually
// propagated into the run's context.
func TestAgentPool_CancelDuringPrepareAbortsRun(t *testing.T) {
	t.Parallel()

	b := bus.NewInProc()
	t.Cleanup(func() { _ = b.Close() })

	prepareEntered := make(chan struct{})
	releasePrepare := make(chan struct{})
	gated := &gatedMessageStore{
		entered:  prepareEntered,
		release:  releasePrepare,
		messages: []llm.ChatMessage{{Role: "user", Content: "hi"}},
	}

	rt := &fakeRuntime{
		runFn: func(ctx context.Context, _ *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
			// RunStream is invoked after Prepare returns. The cancel published
			// mid-Prepare must propagate into ctx; block until it does.
			<-ctx.Done()
			events <- agent.StreamEvent{Type: agent.EventRunCancelled, RunID: runCtx.RunID, Time: time.Now()}
			close(events)
			return nil, ctx.Err()
		},
	}

	agentObj := &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}
	agentOID, _ := bson.ObjectIDFromHex(testAgentID)
	threadOID, _ := bson.ObjectIDFromHex(testThreadID)
	userOID, _ := bson.ObjectIDFromHex(testUserID)
	thread := &model.ThreadDocument{ID: threadOID, AgentID: agentOID, UserID: userOID, Summary: "summary"}

	preparer := NewRunPreparer(RunPreparerConfig{
		Agents:       &fakeAgentStore{agent: agentObj},
		Threads:      &fakeThreadStore{thread: thread},
		Messages:     gated,
		Runs:         &fakeRunStore{snapshot: validSnapshot()},
		Runtime:      rt,
		ToolRegistry: tools.NewEmptyRegistry(),
		Background:   context.Background(),
	})

	pool := NewAgentPool(context.Background(), testAgentID, b, preparer, rt, nil, nil, nil, nil, nil, 1, NewCancelRegistry(0))
	if err := pool.Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(pool.Stop)

	replyCh := make(chan DispatchReply, 1)
	go func() {
		reply, err := b.Request(context.Background(), dispatchTopic(testAgentID), mustPayloadMessage(t, freshDispatchRequest()), 5*time.Second)
		if err != nil {
			replyCh <- DispatchReply{Error: "request error: " + err.Error()}
			return
		}
		var dr DispatchReply
		_ = json.Unmarshal(reply.Body, &dr)
		replyCh <- dr
	}()

	// The worker subscribes to the cancel topic inside watchCancellation,
	// which runs before it reaches the gated store — so by the time Prepare
	// signals it has entered, the cancel subscription already exists.
	mustClose(t, prepareEntered, 2*time.Second)

	// Publish cancel while the worker is parked inside Prepare.
	if err := b.Publish(context.Background(), cancelTopic("run-1"), bus.Message{}); err != nil {
		t.Fatalf("Publish(cancel) error = %v", err)
	}

	// Let Prepare finish; RunStream then observes the already-cancelled context.
	close(releasePrepare)

	select {
	case dr := <-replyCh:
		if dr.Error == "" {
			t.Fatal("reply error was empty, want cancellation error from mid-Prepare cancel")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("dispatch did not complete — mid-Prepare cancel was not honored")
	}
}

type fakeRuntime struct {
	runFn      func(context.Context, *agent.Agent, agent.RunContext, chan<- agent.StreamEvent) (*agent.RunResult, error)
	estimateFn func(context.Context, *agent.Agent, agent.RunContext) int
}

func (f *fakeRuntime) RunStream(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
	if f.runFn != nil {
		return f.runFn(ctx, ag, runCtx, events)
	}
	events <- agent.StreamEvent{Type: agent.EventRunStarted, RunID: runCtx.RunID, Time: time.Now()}
	events <- agent.StreamEvent{Type: agent.EventRunCompleted, RunID: runCtx.RunID, Time: time.Now()}
	close(events)
	return &agent.RunResult{
		Output:      "ok",
		NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "ok"}},
		Steps:       1,
	}, nil
}

func (f *fakeRuntime) EstimateSystemPromptTokens(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext) int {
	if f.estimateFn != nil {
		return f.estimateFn(ctx, ag, runCtx)
	}
	return 0
}

type fakeAgentStore struct {
	agent *agent.Agent
}

func (f *fakeAgentStore) Create(context.Context, string, *agent.Agent) (*agent.Agent, error) {
	return f.agent, nil
}
func (f *fakeAgentStore) GetByID(context.Context, string, string) (*agent.Agent, error) {
	return f.agent, nil
}
func (f *fakeAgentStore) GetByIDSystem(context.Context, string) (*agent.Agent, error) {
	return f.agent, nil
}
func (f *fakeAgentStore) ListByUser(context.Context, string) ([]*agent.Agent, error) {
	return []*agent.Agent{f.agent}, nil
}
func (f *fakeAgentStore) Update(context.Context, string, string, repository.UpdateAgentInput) (*agent.Agent, error) {
	return f.agent, nil
}
func (f *fakeAgentStore) Delete(context.Context, string, string) error { return nil }

type fakeThreadStore struct {
	thread *model.ThreadDocument
}

func (f *fakeThreadStore) Create(context.Context, string, string, string) (*model.ThreadDocument, error) {
	return f.thread, nil
}
func (f *fakeThreadStore) GetByID(context.Context, string, string) (*model.ThreadDocument, error) {
	return f.thread, nil
}
func (f *fakeThreadStore) ListByAgent(context.Context, string, string) ([]*model.ThreadDocument, error) {
	return []*model.ThreadDocument{f.thread}, nil
}
func (f *fakeThreadStore) UpdateSummary(context.Context, string, string, string) error { return nil }
func (f *fakeThreadStore) FindOrCreateSubThread(_ context.Context, _, originatorRunID, agentID string) (string, error) {
	return "sub-" + originatorRunID + "-" + agentID, nil
}

type fakeMessageStore struct {
	messages []llm.ChatMessage
}

func (f *fakeMessageStore) ListRecentByThread(context.Context, string, int) ([]llm.ChatMessage, error) {
	return f.messages, nil
}
func (f *fakeMessageStore) InsertMany(context.Context, string, string, string, []llm.ChatMessage) ([]model.MessageDocument, error) {
	return nil, nil
}
func (f *fakeMessageStore) ListDocsByThread(context.Context, string, int) ([]model.MessageDocument, error) {
	return nil, nil
}

// gatedMessageStore blocks the first ListRecentByThread call until released,
// signaling on `entered` when reached. Used to hold a worker inside
// preparer.Prepare so a cancel can be injected in that precise window.
type gatedMessageStore struct {
	entered     chan struct{}
	release     chan struct{}
	messages    []llm.ChatMessage
	enteredOnce sync.Once
}

func (g *gatedMessageStore) ListRecentByThread(context.Context, string, int) ([]llm.ChatMessage, error) {
	g.enteredOnce.Do(func() { close(g.entered) })
	<-g.release
	return g.messages, nil
}
func (g *gatedMessageStore) InsertMany(context.Context, string, string, string, []llm.ChatMessage) ([]model.MessageDocument, error) {
	return nil, nil
}
func (g *gatedMessageStore) ListDocsByThread(context.Context, string, int) ([]model.MessageDocument, error) {
	return nil, nil
}

type fakeRunStore struct {
	snapshot *agent.RunSnapshot
}

func (f *fakeRunStore) CreateRun(context.Context, string, string, string, string) error { return nil }
func (f *fakeRunStore) CreateChildRun(context.Context, string, string, string, string, string, string) error {
	return nil
}
func (f *fakeRunStore) Save(context.Context, agent.RunSnapshot) error { return nil }
func (f *fakeRunStore) LoadLatest(context.Context, string) (*agent.RunSnapshot, error) {
	if f.snapshot == nil {
		return nil, errors.New("missing checkpoint")
	}
	return f.snapshot, nil
}
func (f *fakeRunStore) TransitionStatus(context.Context, string, string, string) (bool, error) {
	return true, nil
}
func (f *fakeRunStore) TransitionStatusForUser(context.Context, string, string, string, string) (bool, error) {
	return true, nil
}
func (f *fakeRunStore) UpdateStatus(context.Context, string, string, string) error { return nil }
func (f *fakeRunStore) IncrementAttempt(context.Context, string) (int, error)      { return 1, nil }
func (f *fakeRunStore) GetRun(context.Context, string) (*agent.RunInfo, error) {
	return &agent.RunInfo{}, nil
}
func (f *fakeRunStore) GetRunForUser(context.Context, string, string) (*agent.RunInfo, error) {
	return &agent.RunInfo{}, nil
}

func newTestPreparer(rt *fakeRuntime) *RunPreparer {
	agentObj := &agent.Agent{ID: testAgentID, Provider: "fake", Model: "fake", MaxSteps: 5}
	agentOID, _ := bson.ObjectIDFromHex(testAgentID)
	threadOID, _ := bson.ObjectIDFromHex(testThreadID)
	userOID, _ := bson.ObjectIDFromHex(testUserID)
	thread := &model.ThreadDocument{
		ID:      threadOID,
		AgentID: agentOID,
		UserID:  userOID,
		Summary: "summary",
	}
	return NewRunPreparer(RunPreparerConfig{
		Agents:       &fakeAgentStore{agent: agentObj},
		Threads:      &fakeThreadStore{thread: thread},
		Messages:     &fakeMessageStore{messages: []llm.ChatMessage{{Role: "user", Content: "hello"}}},
		Runs:         &fakeRunStore{snapshot: validSnapshot()},
		Runtime:      rt,
		ToolRegistry: tools.NewEmptyRegistry(),
		Background:   context.Background(),
	})
}

func freshDispatchRequest() DispatchRequest {
	return DispatchRequest{
		RunID:    "run-1",
		AgentID:  testAgentID,
		UserID:   testUserID,
		ThreadID: testThreadID,
		Input:    "hello",
		Attempt:  1,
	}
}

func validSnapshot() *agent.RunSnapshot {
	return &agent.RunSnapshot{
		Version: 1,
		RunID:   "run-resume",
		State: agent.RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "hello"}},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{},
		},
		Meta: agent.SnapshotMeta{
			AgentID:  testAgentID,
			ThreadID: testThreadID,
			Attempt:  1,
		},
	}
}

func mustPayloadMessage(t *testing.T, req DispatchRequest) bus.Message {
	t.Helper()
	body, err := json.Marshal(payloadFromRequest(req))
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return bus.Message{Body: body}
}

func hasEvent(types []agent.EventType, want agent.EventType) bool {
	for _, got := range types {
		if got == want {
			return true
		}
	}
	return false
}

func mustClose(t *testing.T, ch <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(timeout):
		t.Fatal("timed out waiting for channel close")
	}
}

func mustReceiveErr(t *testing.T, ch <-chan error, timeout time.Duration) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(timeout):
		t.Fatal("timed out waiting for error")
		return nil
	}
}

func waitGroupDone(t *testing.T, wg *sync.WaitGroup, timeout time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	mustClose(t, done, timeout)
}
