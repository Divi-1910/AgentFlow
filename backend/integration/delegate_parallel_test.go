package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/dispatcher"
	"backend/llm"
	"backend/repo/mongorepo"
	"backend/tools"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type pineappleLLM struct {
	mu               sync.Mutex
	supervisorCalls  int
	recallSawHistory bool
}

func (f *pineappleLLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	switch req.Model {
	case "supervisor-model":
		return f.supervisorReply()
	case "worker-model":
		return f.workerReply(req.Messages)
	default:
		return nil, fmt.Errorf("unexpected model %q", req.Model)
	}
}

func (f *pineappleLLM) supervisorReply() (*llm.ChatResponse, error) {
	f.mu.Lock()
	f.supervisorCalls++
	call := f.supervisorCalls
	f.mu.Unlock()

	if call == 1 {
		return &llm.ChatResponse{
			ToolCalls: []llm.ToolCall{
				delegateCall("ask-store", "ask_worker", "store pineapple"),
				delegateCall("ask-recall", "ask_worker", "recall pineapple"),
			},
		}, nil
	}
	return &llm.ChatResponse{Content: "done"}, nil
}

func (f *pineappleLLM) workerReply(messages []llm.ChatMessage) (*llm.ChatResponse, error) {
	current := lastUserContent(messages)
	switch {
	case strings.Contains(current, "store pineapple"):
		// If same-target delegate calls stop serializing, the recall run can
		// prepare while this run is still active and before sub-thread
		// persistence has happened.
		time.Sleep(150 * time.Millisecond)
		return &llm.ChatResponse{Content: "stored pineapple in worker sub-thread"}, nil
	case strings.Contains(current, "recall pineapple"):
		if priorMessagesContain(messages, current, "store pineapple") {
			f.mu.Lock()
			f.recallSawHistory = true
			f.mu.Unlock()
			return &llm.ChatResponse{Content: "recalled pineapple from sub-thread"}, nil
		}
		return &llm.ChatResponse{Content: "missing pineapple history"}, nil
	default:
		return nil, fmt.Errorf("unexpected worker input %q", current)
	}
}

func (f *pineappleLLM) sawRecallHistory() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.recallSawHistory
}

type budgetLLM struct {
	mu              sync.Mutex
	supervisorCalls int
	workerCalls     int
}

func (f *budgetLLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	switch req.Model {
	case "budget-supervisor":
		f.mu.Lock()
		f.supervisorCalls++
		call := f.supervisorCalls
		f.mu.Unlock()
		if call == 1 {
			return &llm.ChatResponse{
				ToolCalls: []llm.ToolCall{
					delegateCall("ask-one", "ask_worker", "first child"),
					delegateCall("ask-two", "ask_worker", "second child"),
				},
			}, nil
		}
		return &llm.ChatResponse{Content: "done"}, nil
	case "budget-worker":
		f.mu.Lock()
		f.workerCalls++
		f.mu.Unlock()
		return &llm.ChatResponse{Content: "worker result"}, nil
	default:
		return nil, fmt.Errorf("unexpected model %q", req.Model)
	}
}

func (f *budgetLLM) workerCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.workerCalls
}

func delegateCall(id, name, task string) llm.ToolCall {
	args, _ := json.Marshal(map[string]string{"task": task})
	return llm.ToolCall{ID: id, Name: name, Arguments: args}
}

func lastUserContent(messages []llm.ChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			return messages[i].Content
		}
	}
	return ""
}

func priorMessagesContain(messages []llm.ChatMessage, current, needle string) bool {
	for _, m := range messages {
		if m.Role == "user" && m.Content == current {
			continue
		}
		if strings.Contains(m.Content, needle) {
			return true
		}
	}
	return false
}

func integrationToolMessages(messages []llm.ChatMessage) []llm.ChatMessage {
	out := make([]llm.ChatMessage, 0)
	for _, m := range messages {
		if m.Role == "tool" {
			out = append(out, m)
		}
	}
	return out
}

func TestSameTargetDelegateBatchUsesMongoSubThreadHistory(t *testing.T) {
	ctx := context.Background()
	col := func(prefix string) *mongo.Collection {
		c := testDB.Collection(prefix + "_" + sanitize(t.Name()))
		t.Cleanup(func() { _ = c.Drop(context.Background()) })
		return c
	}

	agentRepo := mongorepo.NewAgentRepo(col("agents"), col("models"))
	threadCol := col("threads")
	threadRepo := mongorepo.NewThreadRepo(threadCol)
	if err := threadRepo.EnsureIndexes(ctx); err != nil {
		t.Fatalf("Thread EnsureIndexes: %v", err)
	}
	messageRepo := mongorepo.NewMessageRepo(col("messages"))
	runRepo := mongorepo.NewRunRepo(col("runs"), col("checkpoints"))
	if err := runRepo.EnsureIndexes(ctx); err != nil {
		t.Fatalf("Run EnsureIndexes: %v", err)
	}

	llmClient := &pineappleLLM{}
	llmReg := llm.NewEmptyLLMRegistry()
	llmReg.Register("fake", llmClient)
	toolReg := tools.NewEmptyRegistry()
	contextBuilder := agent.NewContextBuilder(
		&agent.PlatformConfig{Body: "<platform>integration test</platform>"},
		nil,
		nil,
		nil,
	)
	capabilities := agent.ToolCapabilities{AsyncJobs: true}
	runtime := agent.NewAgentRuntime(llmReg, toolReg, contextBuilder, capabilities).WithCheckpointStore(runRepo)

	theBus := bus.NewInProc()
	t.Cleanup(func() { _ = theBus.Close() })
	preparer := dispatcher.NewRunPreparer(dispatcher.RunPreparerConfig{
		Agents:       agentRepo,
		Threads:      threadRepo,
		Messages:     messageRepo,
		Runs:         runRepo,
		Runtime:      runtime,
		ToolRegistry: toolReg,
		Background:   ctx,
		Capabilities: capabilities,
	})
	pools := dispatcher.NewPoolManager(dispatcher.PoolManagerConfig{
		RootCtx:  ctx,
		Bus:      theBus,
		Preparer: preparer,
		Runtime:  runtime,
		Status:   runRepo,
		Workers:  4,
	})
	t.Cleanup(pools.StopAll)
	runtime.SetDelegateInvoker(dispatcher.NewBusDelegateInvoker(dispatcher.BusDelegateInvokerConfig{
		Bus:           theBus,
		Pools:         pools,
		Agents:        agentRepo,
		Threads:       threadRepo,
		Runs:          runRepo,
		Messages:      messageRepo,
		SafetyTimeout: 5 * time.Second,
	}))

	userID := bson.NewObjectID().Hex()
	worker, err := agentRepo.Create(ctx, userID, &agent.Agent{
		Name:         "Worker",
		Provider:     "fake",
		Model:        "worker-model",
		SystemPrompt: "Remember and recall facts from your conversation history.",
		MaxSteps:     3,
	})
	if err != nil {
		t.Fatalf("create worker: %v", err)
	}
	supervisor, err := agentRepo.Create(ctx, userID, &agent.Agent{
		Name:         "Supervisor",
		Provider:     "fake",
		Model:        "supervisor-model",
		SystemPrompt: "Delegate to the worker.",
		Delegates: []agent.DelegateConfig{{
			AgentID:     worker.ID,
			ToolName:    "ask_worker",
			Description: "ask the worker",
		}},
		MaxSteps: 3,
	})
	if err != nil {
		t.Fatalf("create supervisor: %v", err)
	}
	thread, err := threadRepo.Create(ctx, userID, supervisor.ID, "pineapple")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	runID := uuid.NewString()
	if err := runRepo.CreateRun(ctx, runID, thread.ID, supervisor.ID, userID); err != nil {
		t.Fatalf("create run: %v", err)
	}

	events := make(chan agent.StreamEvent, 512)
	eventsDone := make(chan struct{})
	go func() {
		for range events {
		}
		close(eventsDone)
	}()

	disp := &dispatcher.DirectDispatcher{
		Preparer: preparer,
		Runtime:  runtime,
		Bus:      theBus,
		Pools:    pools,
	}
	result, err := disp.Dispatch(ctx, dispatcher.DispatchRequest{
		RunID:    runID,
		AgentID:  supervisor.ID,
		UserID:   userID,
		ThreadID: thread.ID,
		Input:    "store and recall pineapple",
	}, events)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	<-eventsDone

	if !llmClient.sawRecallHistory() {
		t.Fatal("worker recall run did not see the first delegate result in sub-thread history")
	}
	tools := integrationToolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("top-level tool messages = %d, want 2: %+v", len(tools), result.NewMessages)
	}
	if tools[0].Content != "stored pineapple in worker sub-thread" {
		t.Fatalf("first delegate result = %q", tools[0].Content)
	}
	if tools[1].Content != "recalled pineapple from sub-thread" {
		t.Fatalf("second delegate result = %q", tools[1].Content)
	}

	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		t.Fatalf("parse user id: %v", err)
	}
	workerOID, err := bson.ObjectIDFromHex(worker.ID)
	if err != nil {
		t.Fatalf("parse worker id: %v", err)
	}
	count, err := threadCol.CountDocuments(ctx, bson.M{
		"user_id":           uid,
		"agent_id":          workerOID,
		"originator_run_id": runID,
		"kind":              "sub",
	})
	if err != nil {
		t.Fatalf("count sub-threads: %v", err)
	}
	if count != 1 {
		t.Fatalf("sub-thread count = %d, want 1", count)
	}
}

func TestSyncDelegateRunBudgetLimitsSupervisorFanout(t *testing.T) {
	ctx := context.Background()
	col := func(prefix string) *mongo.Collection {
		c := testDB.Collection(prefix + "_" + sanitize(t.Name()))
		t.Cleanup(func() { _ = c.Drop(context.Background()) })
		return c
	}

	agentRepo := mongorepo.NewAgentRepo(col("agents"), col("models"))
	threadCol := col("threads")
	threadRepo := mongorepo.NewThreadRepo(threadCol)
	if err := threadRepo.EnsureIndexes(ctx); err != nil {
		t.Fatalf("Thread EnsureIndexes: %v", err)
	}
	messageRepo := mongorepo.NewMessageRepo(col("messages"))
	runsCol := col("runs")
	runRepo := mongorepo.NewRunRepo(runsCol, col("checkpoints"))
	if err := runRepo.EnsureIndexes(ctx); err != nil {
		t.Fatalf("Run EnsureIndexes: %v", err)
	}
	taskCol := col("tasks")
	taskRepo := mongorepo.NewTaskRepo(taskCol)
	if err := taskRepo.EnsureIndexes(ctx); err != nil {
		t.Fatalf("Task EnsureIndexes: %v", err)
	}

	llmClient := &budgetLLM{}
	llmReg := llm.NewEmptyLLMRegistry()
	llmReg.Register("fake", llmClient)
	toolReg := tools.NewEmptyRegistry()
	contextBuilder := agent.NewContextBuilder(
		&agent.PlatformConfig{Body: "<platform>integration test</platform>"},
		nil,
		nil,
		nil,
	)
	capabilities := agent.ToolCapabilities{AsyncJobs: true}
	runtime := agent.NewAgentRuntime(llmReg, toolReg, contextBuilder, capabilities).WithCheckpointStore(runRepo)

	theBus := bus.NewInProc()
	t.Cleanup(func() { _ = theBus.Close() })
	preparer := dispatcher.NewRunPreparer(dispatcher.RunPreparerConfig{
		Agents:       agentRepo,
		Threads:      threadRepo,
		Messages:     messageRepo,
		Runs:         runRepo,
		Runtime:      runtime,
		ToolRegistry: toolReg,
		Tasks:        taskRepo,
		Background:   ctx,
		Capabilities: capabilities,
	})
	pools := dispatcher.NewPoolManager(dispatcher.PoolManagerConfig{
		RootCtx:  ctx,
		Bus:      theBus,
		Preparer: preparer,
		Runtime:  runtime,
		Status:   runRepo,
		Tasks:    taskRepo,
		Workers:  4,
	})
	t.Cleanup(pools.StopAll)
	runtime.SetDelegateInvoker(dispatcher.NewBusDelegateInvoker(dispatcher.BusDelegateInvokerConfig{
		Bus:           theBus,
		Pools:         pools,
		Agents:        agentRepo,
		Threads:       threadRepo,
		Runs:          runRepo,
		Messages:      messageRepo,
		Tasks:         taskRepo,
		SafetyTimeout: 5 * time.Second,
	}))

	userID := bson.NewObjectID().Hex()
	worker, err := agentRepo.Create(ctx, userID, &agent.Agent{
		Name:         "Worker",
		Provider:     "fake",
		Model:        "budget-worker",
		SystemPrompt: "Answer delegated tasks.",
		MaxSteps:     3,
	})
	if err != nil {
		t.Fatalf("create worker: %v", err)
	}
	supervisor, err := agentRepo.Create(ctx, userID, &agent.Agent{
		Name:         "Supervisor",
		Provider:     "fake",
		Model:        "budget-supervisor",
		SystemPrompt: "Delegate twice.",
		Delegates: []agent.DelegateConfig{{
			AgentID:     worker.ID,
			ToolName:    "ask_worker",
			Description: "ask the worker",
		}},
		MaxSteps: 3,
		MaxRuns:  1,
	})
	if err != nil {
		t.Fatalf("create supervisor: %v", err)
	}
	thread, err := threadRepo.Create(ctx, userID, supervisor.ID, "budget")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	runID := uuid.NewString()
	if err := runRepo.CreateRun(ctx, runID, thread.ID, supervisor.ID, userID); err != nil {
		t.Fatalf("create run: %v", err)
	}

	events := make(chan agent.StreamEvent, 512)
	eventsDone := make(chan struct{})
	go func() {
		for range events {
		}
		close(eventsDone)
	}()

	disp := &dispatcher.DirectDispatcher{
		Preparer: preparer,
		Runtime:  runtime,
		Bus:      theBus,
		Pools:    pools,
	}
	result, err := disp.Dispatch(ctx, dispatcher.DispatchRequest{
		RunID:    runID,
		AgentID:  supervisor.ID,
		UserID:   userID,
		ThreadID: thread.ID,
		Input:    "delegate twice",
	}, events)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	<-eventsDone

	if got := llmClient.workerCallCount(); got != 1 {
		t.Fatalf("worker calls = %d, want exactly 1 admitted child", got)
	}
	tools := integrationToolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("top-level tool messages = %d, want 2: %+v", len(tools), result.NewMessages)
	}
	if tools[0].Metadata["is_error"] == true || tools[0].Content != "worker result" {
		t.Fatalf("first tool message = %+v, want successful worker result", tools[0])
	}
	if tools[1].Metadata["is_error"] != true || !strings.Contains(tools[1].Content, "run budget exhausted") {
		t.Fatalf("second tool message = %+v, want budget IsError", tools[1])
	}

	var taskDoc struct {
		MaxRuns  int      `bson:"max_runs"`
		RunsUsed int      `bson:"runs_used"`
		RunKeys  []string `bson:"run_budget_keys"`
	}
	if err := taskCol.FindOne(ctx, bson.M{"originator_run_id": runID}).Decode(&taskDoc); err != nil {
		t.Fatalf("find task doc: %v", err)
	}
	if taskDoc.MaxRuns != 1 || taskDoc.RunsUsed != 1 || len(taskDoc.RunKeys) != 1 {
		t.Fatalf("task budget doc = %+v, want max=1 used=1 one key", taskDoc)
	}
	childRuns, err := runsCol.CountDocuments(ctx, bson.M{"originator_run_id": runID, "parent_run_id": runID})
	if err != nil {
		t.Fatalf("count child runs: %v", err)
	}
	if childRuns != 1 {
		t.Fatalf("child run count = %d, want 1", childRuns)
	}
}
