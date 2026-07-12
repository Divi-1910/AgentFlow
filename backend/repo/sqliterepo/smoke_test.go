package sqliterepo_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/dispatcher"
	"backend/llm"
	"backend/model"
	"backend/repo/sqliterepo"
	"backend/runtimectx"
	"backend/tools"
)

type mapAgentReader struct {
	userID string
	agents map[string]*agent.Agent
}

func (r *mapAgentReader) GetByID(_ context.Context, agentID, userID string) (*agent.Agent, error) {
	if userID != r.userID {
		return nil, fmt.Errorf("agent not found")
	}
	return r.GetByIDSystem(context.Background(), agentID)
}

func (r *mapAgentReader) GetByIDSystem(_ context.Context, agentID string) (*agent.Agent, error) {
	ag, ok := r.agents[agentID]
	if !ok {
		return nil, fmt.Errorf("agent not found")
	}
	return ag, nil
}

type blockingLLM struct{ entered chan struct{} }

func (f *blockingLLM) ChatCompletion(ctx context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
	select {
	case f.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type finalLLM struct{ content string }

func (f finalLLM) ChatCompletion(context.Context, *llm.ChatRequest) (*llm.ChatResponse, error) {
	return &llm.ChatResponse{Content: f.content, Model: "fake"}, nil
}

type delegationLLM struct {
	mu sync.Mutex
}

func (f *delegationLLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	if req.Model == "worker" {
		return &llm.ChatResponse{Content: "worker answer", Model: req.Model}, nil
	}
	for _, message := range req.Messages {
		if message.Role == "tool" {
			return &llm.ChatResponse{Content: "supervisor complete", Model: req.Model}, nil
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return &llm.ChatResponse{
		Model: req.Model,
		ToolCalls: []llm.ToolCall{{
			ID: "delegate-call", Name: "ask_worker", Arguments: json.RawMessage(`{"task":"do the work"}`),
		}},
	}, nil
}

func testRuntime(t *testing.T, client llm.LLMClient, runRepo *sqliterepo.RunRepo, capabilities agent.ToolCapabilities) (*agent.AgentRuntime, *tools.ToolRegistry) {
	t.Helper()
	registry := llm.NewEmptyLLMRegistry()
	registry.Register("fake", client)
	toolRegistry := tools.NewEmptyRegistry()
	builder := agent.NewContextBuilder(&agent.PlatformConfig{Body: "<platform>sqlite smoke</platform>"}, nil, nil, nil)
	runtime := agent.NewAgentRuntime(registry, toolRegistry, builder, capabilities).WithCheckpointStore(runRepo)
	return runtime, toolRegistry
}

func TestFileReopenResumeAndSynchronousDelegation(t *testing.T) {
	path := t.TempDir() + "/runtime.db"
	ctx := context.Background()
	userID := "user-1"
	agentID := "resume-agent"
	threadID := "resume-thread"
	runID := "resume-run"

	db1, err := sqliterepo.Open(path, sqliterepo.Options{})
	if err != nil {
		t.Fatalf("Open(first): %v", err)
	}
	runs1 := sqliterepo.NewRunRepo(db1)
	messages1 := sqliterepo.NewMessageRepo(db1)
	if _, err := messages1.InsertMany(ctx, threadID, agentID, userID, []llm.ChatMessage{{Role: "user", Content: "persist me"}}); err != nil {
		t.Fatalf("InsertMany: %v", err)
	}
	if err := runs1.CreateRun(ctx, runID, threadID, agentID, userID); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	blocked := &blockingLLM{entered: make(chan struct{}, 1)}
	runtime1, _ := testRuntime(t, blocked, runs1, agent.ToolCapabilities{AsyncJobs: false})
	ag := &agent.Agent{ID: agentID, Provider: "fake", Model: "resume", SystemPrompt: "resume", MaxSteps: 3}
	runCtx := agent.RunContext{
		RunID: runID, ThreadID: threadID, Input: "persist me", Attempt: 1,
		OriginatorRunID: runID, DelegationChain: []string{agentID},
		Memory: runtimectx.MemoryScope{UserID: userID, AgentID: agentID, ThreadID: threadID},
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, err := runtime1.Run(cancelCtx, ag, runCtx)
		done <- err
	}()
	select {
	case <-blocked.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("fake LLM was not reached")
	}
	snapshot, err := runs1.LoadLatest(ctx, runID)
	if err != nil {
		t.Fatalf("LoadLatest before cancel: %v", err)
	}
	if snapshot.Meta.Phase != agent.PhasePreModel {
		t.Fatalf("checkpoint phase = %q, want %q", snapshot.Meta.Phase, agent.PhasePreModel)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled run error = %v", err)
	}
	info, err := runs1.GetRun(ctx, runID)
	if err != nil || info.Status != string(model.RunStatusInterrupted) {
		t.Fatalf("interrupted run = %+v, %v", info, err)
	}
	if err := db1.Close(); err != nil {
		t.Fatalf("Close(first): %v", err)
	}

	// Reopen from disk and reconstruct every runtime/store object.
	db2, err := sqliterepo.Open(path, sqliterepo.Options{})
	if err != nil {
		t.Fatalf("Open(second): %v", err)
	}
	defer db2.Close()
	runs := sqliterepo.NewRunRepo(db2)
	threads := sqliterepo.NewThreadRepo(db2)
	messages := sqliterepo.NewMessageRepo(db2)
	tasks := sqliterepo.NewTaskRepo(db2)
	runtime2, toolRegistry := testRuntime(t, finalLLM{content: "resumed complete"}, runs, agent.ToolCapabilities{AsyncJobs: false})
	claimed, err := runs.TransitionStatusForUser(ctx, runID, userID, string(model.RunStatusInterrupted), string(model.RunStatusRunning))
	if err != nil || !claimed {
		t.Fatalf("owner CAS: claimed=%v err=%v", claimed, err)
	}
	snapshot, err = runs.LoadLatest(ctx, runID)
	if err != nil {
		t.Fatalf("LoadLatest(reopen): %v", err)
	}
	validationSet, err := agent.BuildToolSetForValidation(toolRegistry, ag, agent.ToolCapabilities{AsyncJobs: false})
	if err != nil {
		t.Fatalf("build validation toolset: %v", err)
	}
	if err := agent.ValidateSnapshot(snapshot, validationSet); err != nil {
		t.Fatalf("snapshot validation: %v", err)
	}
	attempt, err := runs.IncrementAttempt(ctx, runID)
	if err != nil || attempt != 2 {
		t.Fatalf("IncrementAttempt = %d, %v", attempt, err)
	}
	snapshot.Meta.Attempt = attempt
	result, err := runtime2.Run(ctx, ag, agent.RunContext{
		RunID: runID, ThreadID: threadID, Attempt: attempt, Checkpoint: snapshot,
		OriginatorRunID: runID, DelegationChain: []string{agentID},
		Memory: runtimectx.MemoryScope{UserID: userID, AgentID: agentID, ThreadID: threadID},
	})
	if err != nil || result.Output != "resumed complete" {
		t.Fatalf("resume result = %+v, %v", result, err)
	}
	info, err = runs.GetRun(ctx, runID)
	if err != nil || info.Status != string(model.RunStatusCompleted) || info.Attempt != 2 {
		t.Fatalf("completed run = %+v, %v", info, err)
	}
	persisted, err := messages.ListDocsByThread(ctx, threadID, 10)
	if err != nil || len(persisted) != 1 || persisted[0].Content != "persist me" {
		t.Fatalf("persisted user history = %+v, %v", persisted, err)
	}

	// A separate top-level run delegates synchronously through the in-process
	// bus. Async tools/stores and durable cancellation remain absent.
	supervisor := &agent.Agent{
		ID: "supervisor", Provider: "fake", Model: "supervisor", SystemPrompt: "supervise", MaxSteps: 4, MaxRuns: 3,
		Delegates: []agent.DelegateConfig{{AgentID: "worker", ToolName: "ask_worker", Description: "ask worker"}},
	}
	worker := &agent.Agent{ID: "worker", Provider: "fake", Model: "worker", SystemPrompt: "work", MaxSteps: 2}
	reader := &mapAgentReader{userID: userID, agents: map[string]*agent.Agent{supervisor.ID: supervisor, worker.ID: worker}}
	delegationRuntime, delegationTools := testRuntime(t, &delegationLLM{}, runs, agent.ToolCapabilities{AsyncJobs: false})
	theBus := bus.NewInProc()
	defer theBus.Close()
	rootCtx, stop := context.WithCancel(context.Background())
	defer stop()
	preparer := dispatcher.NewRunPreparer(dispatcher.RunPreparerConfig{
		Agents: reader, Threads: threads, Messages: messages, Runs: runs,
		Runtime: delegationRuntime, ToolRegistry: delegationTools, Tasks: tasks,
		Background: rootCtx, Capabilities: agent.ToolCapabilities{AsyncJobs: false},
	})
	pools := dispatcher.NewPoolManager(dispatcher.PoolManagerConfig{
		RootCtx: rootCtx, Bus: theBus, Preparer: preparer, Runtime: delegationRuntime,
		Status: runs, Messages: messages, Workers: 1,
	})
	defer pools.StopAll()
	invoker := dispatcher.NewBusDelegateInvoker(dispatcher.BusDelegateInvokerConfig{
		Bus: theBus, Pools: pools, Agents: reader, Threads: threads, Runs: runs,
		Messages: messages, Tasks: tasks, SafetyTimeout: 5 * time.Second,
	})
	delegationRuntime.SetDelegateInvoker(invoker)
	topThread, err := threads.Create(ctx, userID, supervisor.ID, "delegation")
	if err != nil {
		t.Fatalf("Create top thread: %v", err)
	}
	if _, err := messages.InsertMany(ctx, topThread.ID, supervisor.ID, userID, []llm.ChatMessage{{Role: "user", Content: "delegate"}}); err != nil {
		t.Fatalf("insert top message: %v", err)
	}
	topRunID := "delegation-run"
	if err := runs.CreateRun(ctx, topRunID, topThread.ID, supervisor.ID, userID); err != nil {
		t.Fatalf("Create top run: %v", err)
	}
	direct := &dispatcher.DirectDispatcher{Preparer: preparer, Runtime: delegationRuntime, Bus: theBus, Pools: pools}
	events := make(chan agent.StreamEvent, 128)
	dispatchCtx, dispatchCancel := context.WithTimeout(ctx, 5*time.Second)
	defer dispatchCancel()
	delegated, err := direct.Dispatch(dispatchCtx, dispatcher.DispatchRequest{
		RunID: topRunID, AgentID: supervisor.ID, UserID: userID, ThreadID: topThread.ID, Input: "delegate",
	}, events)
	if err != nil || delegated.Output != "supervisor complete" {
		t.Fatalf("delegated result = %+v, %v", delegated, err)
	}

	var childOriginator, childParent, childKind string
	if err := db2.QueryRow(`SELECT originator_run_id, parent_run_id, invocation_kind FROM runs WHERE parent_run_id = ?`, topRunID).
		Scan(&childOriginator, &childParent, &childKind); err != nil {
		t.Fatalf("child lineage query: %v", err)
	}
	if childOriginator != topRunID || childParent != topRunID || childKind != agent.InvocationSyncDelegate {
		t.Fatalf("child lineage = %q/%q/%q", childOriginator, childParent, childKind)
	}
	var subThreadID string
	var subThreadCount int
	if err := db2.QueryRow(`SELECT count(*), min(id) FROM threads WHERE kind='sub' AND originator_run_id=?`, topRunID).
		Scan(&subThreadCount, &subThreadID); err != nil || subThreadCount != 1 {
		t.Fatalf("sub-thread count/id = %d/%q, %v", subThreadCount, subThreadID, err)
	}
	subHistory, err := messages.ListDocsByThread(ctx, subThreadID, 10)
	if err != nil || len(subHistory) < 2 || subHistory[0].Content != "do the work" {
		t.Fatalf("sub-thread history = %+v, %v", subHistory, err)
	}
	budget, err := tasks.BudgetStatus(ctx, topRunID)
	if err != nil || budget.RunsUsed != 1 {
		t.Fatalf("budget = %+v, %v", budget, err)
	}
}
