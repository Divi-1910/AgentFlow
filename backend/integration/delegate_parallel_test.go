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
	"backend/repository"
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

	agentRepo := repository.NewAgentRepo(col("agents"), col("models"))
	threadCol := col("threads")
	threadRepo := repository.NewThreadRepo(threadCol)
	if err := threadRepo.EnsureIndexes(ctx); err != nil {
		t.Fatalf("Thread EnsureIndexes: %v", err)
	}
	messageRepo := repository.NewMessageRepo(col("messages"))
	runRepo := repository.NewRunRepo(col("runs"), col("checkpoints"))
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
	)
	runtime := agent.NewAgentRuntime(llmReg, toolReg, contextBuilder).WithCheckpointStore(runRepo)

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
	if err := runRepo.CreateRun(ctx, runID, thread.ID.Hex(), supervisor.ID, userID); err != nil {
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
		ThreadID: thread.ID.Hex(),
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
