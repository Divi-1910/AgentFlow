package agent

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"backend/llm"
	"backend/runtimectx"
	"backend/tools"
)

type fakeAsyncJobStore struct {
	dispatched    []DispatchAgentRequest
	dispatchErr   error
	pendingJobs   []PendingRequiredJob
	awaitByJob    map[string]AwaitJobResult
	markAwaiting  []PendingAwait
	deliveredJobs []string
}

func (s *fakeAsyncJobStore) DispatchAgent(_ context.Context, req DispatchAgentRequest) (DispatchAgentResult, error) {
	if s.dispatchErr != nil {
		return DispatchAgentResult{}, s.dispatchErr
	}
	s.dispatched = append(s.dispatched, req)
	jobID := "job-1"
	if len(s.pendingJobs) == 0 {
		s.pendingJobs = []PendingRequiredJob{{JobID: jobID, CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), DelegateTool: req.DelegateTool}}
	}
	return DispatchAgentResult{JobID: jobID, Status: "queued", Mode: req.Mode, DelegateTool: req.DelegateTool}, nil
}

func (s *fakeAsyncJobStore) AwaitJob(_ context.Context, req AwaitJobRequest) (AwaitJobResult, error) {
	if res, ok := s.awaitByJob[req.JobID]; ok {
		return res, nil
	}
	return AwaitJobResult{
		JobID:        req.JobID,
		Status:       "queued",
		Pending:      true,
		CreatedAt:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		DelegateTool: "ask_researcher",
	}, nil
}

func (s *fakeAsyncJobStore) PendingRequiredJobs(_ context.Context, _, _ string) ([]PendingRequiredJob, error) {
	delivered := make(map[string]bool, len(s.deliveredJobs))
	for _, jobID := range s.deliveredJobs {
		delivered[jobID] = true
	}
	out := make([]PendingRequiredJob, 0, len(s.pendingJobs))
	for _, job := range s.pendingJobs {
		if delivered[job.JobID] {
			continue
		}
		out = append(out, job)
	}
	return out, nil
}

func (s *fakeAsyncJobStore) MarkAwaiting(_ context.Context, _ string, awaits []PendingAwait) error {
	s.markAwaiting = append([]PendingAwait(nil), awaits...)
	return nil
}

func (s *fakeAsyncJobStore) ResolveAwaits(_ context.Context, _, _ string, awaits []PendingAwait) ([]AwaitJobResult, bool, error) {
	results := make([]AwaitJobResult, 0, len(awaits))
	allTerminal := true
	for _, a := range awaits {
		res, ok := s.awaitByJob[a.JobID]
		if !ok {
			res = AwaitJobResult{JobID: a.JobID, Status: "running", Pending: true, CreatedAt: a.CreatedAt, DelegateTool: a.DelegateTool}
		}
		if res.Pending {
			allTerminal = false
		}
		results = append(results, res)
	}
	return results, allTerminal, nil
}

func (s *fakeAsyncJobStore) MarkDelivered(_ context.Context, _, _ string, results []AwaitJobResult, _ []PendingAwait) error {
	for _, res := range results {
		s.deliveredJobs = append(s.deliveredJobs, res.JobID)
	}
	return nil
}

func TestDispatchAgentToolReturnsIsErrorForRunBudgetExhaustion(t *testing.T) {
	store := &fakeAsyncJobStore{dispatchErr: RunBudgetError{MaxRuns: 1, RunsUsed: 1}}
	ts := newToolSet()
	ts.add("ask_researcher", newDelegateTool(DelegateConfig{
		AgentID:     "agent-b",
		ToolName:    "ask_researcher",
		Description: "research",
	}, &stubInvoker{}), toolKindDelegate)
	tool := newDispatchAgentTool(ts, store)
	ctx := withAsyncRunInfo(context.Background(), asyncRunInfo{
		RunID:           "parent-run",
		OriginatorRunID: "origin-run",
		ThreadID:        "thread-1",
		AgentID:         "agent-a",
		UserID:          "user-1",
		InvocationKind:  InvocationTopLevel,
		Chain:           []string{"agent-a"},
	})

	res, err := tool.Execute(ctx, tools.ToolCall{
		ID:   "dispatch-1",
		Args: json.RawMessage(`{"delegate_tool":"ask_researcher","task":"research","mode":"required"}`),
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("result = %+v, want IsError", res)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(res.Content), &body); err != nil {
		t.Fatalf("unmarshal content: %v", err)
	}
	if body["error"] != "run budget exhausted" || body["max_runs"] != float64(1) || body["runs_used"] != float64(1) {
		t.Fatalf("content = %s", res.Content)
	}
}

func newAsyncRuntime(lm llm.LLMClient, store AsyncJobStore, checkpointStore CheckpointStore) (*AgentRuntime, *Agent) {
	rt, ag := newTestRuntime(lm, checkpointStore)
	rt.SetAsyncJobStore(store)
	rt.SetDelegateInvoker(&stubInvoker{})
	ag.Tools = nil
	ag.Delegates = []DelegateConfig{{
		AgentID:     "agent-b",
		ToolName:    "ask_researcher",
		Description: "delegate research",
	}}
	return rt, ag
}

func asyncRunCtx() RunContext {
	return RunContext{
		RunID:           "run-test",
		ThreadID:        "thread-test",
		Input:           "research this",
		OriginatorRunID: "run-test",
		DelegationChain: []string{"agent-a"},
		Memory: runtimectx.MemoryScope{
			UserID:   "user-test",
			AgentID:  "agent-a",
			ThreadID: "thread-test",
		},
	}
}

func TestAsyncRequiredDispatchAutoAwaitSuspendsRun(t *testing.T) {
	store := &fakeAsyncJobStore{awaitByJob: map[string]AwaitJobResult{}}
	args, _ := json.Marshal(map[string]string{
		"delegate_tool": "ask_researcher",
		"task":          "find evidence",
		"mode":          JobModeRequired,
	})
	lm := &fakeLLM{replies: []fakeReply{
		toolCallReply(AsyncToolDispatchAgent, "dispatch-1", args),
		textReply("premature final answer"),
	}}
	checkpoints := &fakeCheckpointStore{}
	rt, ag := newAsyncRuntime(lm, store, checkpoints)
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, asyncRunCtx(), sink)
	if err != nil {
		t.Fatalf("runInternal: %v", err)
	}
	if result.Status != RunResultWaiting {
		t.Fatalf("result status = %q, want %q", result.Status, RunResultWaiting)
	}
	if !sink.has(EventRunWaiting) {
		t.Fatalf("run.waiting event missing: %v", sink.types())
	}
	if len(store.markAwaiting) != 1 || store.markAwaiting[0].JobID != "job-1" {
		t.Fatalf("MarkAwaiting = %+v, want one await for job-1", store.markAwaiting)
	}
	if got := store.markAwaiting[0].AwaitToolCallID; got != "auto-await:run-test:job-1" {
		t.Fatalf("auto await call id = %q", got)
	}
	last := checkpoints.saves[len(checkpoints.saves)-1]
	if last.Meta.Phase != PhaseWaitingJobs {
		t.Fatalf("last checkpoint phase = %q, want %q", last.Meta.Phase, PhaseWaitingJobs)
	}
	for _, msg := range result.NewMessages {
		if msg.Role == "assistant" && msg.Content == "premature final answer" {
			t.Fatal("auto-await should discard premature final text")
		}
	}
}

func TestWaitingResumeAppendsAwaitResultBeforeModelCall(t *testing.T) {
	awaitID := "auto-await:run-test:job-1"
	awaitArgs, _ := json.Marshal(map[string]string{"job_id": "job-1"})
	store := &fakeAsyncJobStore{awaitByJob: map[string]AwaitJobResult{
		"job-1": {
			JobID:        "job-1",
			Status:       "succeeded",
			Output:       "research output",
			CreatedAt:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			DelegateTool: "ask_researcher",
		},
	}}
	lm := &fakeLLM{replies: []fakeReply{textReply("final with research")}}
	rt, ag := newAsyncRuntime(lm, store, nil)
	runCtx := asyncRunCtx()
	runCtx.Checkpoint = &RunSnapshot{
		Version: 1,
		RunID:   runCtx.RunID,
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "research this"},
				{Role: "assistant", ToolCalls: []llm.ToolCall{{ID: awaitID, Name: AsyncToolAwaitJob, Arguments: awaitArgs}}},
			},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{},
			PendingAwaits: []PendingAwait{{
				JobID:           "job-1",
				AwaitToolCallID: awaitID,
				CreatedAt:       time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
				Auto:            true,
				DelegateTool:    "ask_researcher",
			}},
		},
		Meta: SnapshotMeta{
			AgentID:         ag.ID,
			ThreadID:        runCtx.ThreadID,
			Provider:        ag.Provider,
			Model:           ag.Model,
			Attempt:         1,
			Phase:           PhaseWaitingJobs,
			OriginatorRunID: runCtx.OriginatorRunID,
			DelegationChain: runCtx.DelegationChain,
		},
	}
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)
	if err != nil {
		t.Fatalf("runInternal: %v", err)
	}
	if result.Status != RunResultCompleted || result.Output != "final with research" {
		t.Fatalf("result = (%q, %q), want completed final", result.Status, result.Output)
	}
	if len(store.deliveredJobs) != 1 || store.deliveredJobs[0] != "job-1" {
		t.Fatalf("delivered jobs = %v, want [job-1]", store.deliveredJobs)
	}
	if len(result.NewMessages) < 2 || result.NewMessages[0].Role != "tool" || result.NewMessages[0].ToolCallID != awaitID {
		t.Fatalf("new messages should start with await tool result: %+v", result.NewMessages)
	}
	if result.NewMessages[0].Content == "" || result.NewMessages[1].Content != "final with research" {
		t.Fatalf("unexpected new messages: %+v", result.NewMessages)
	}
}

func TestAsyncRequiredInlineTerminalAwaitMarksDeliveredAndFinalizes(t *testing.T) {
	store := &fakeAsyncJobStore{awaitByJob: map[string]AwaitJobResult{
		"job-1": {
			JobID:        "job-1",
			Status:       "succeeded",
			Output:       "fast research output",
			CreatedAt:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			DelegateTool: "ask_researcher",
		},
	}}
	dispatchArgs, _ := json.Marshal(map[string]string{
		"delegate_tool": "ask_researcher",
		"task":          "find evidence",
		"mode":          JobModeRequired,
	})
	awaitArgs, _ := json.Marshal(map[string]string{"job_id": "job-1"})
	lm := &fakeLLM{replies: []fakeReply{
		toolCallReply(AsyncToolDispatchAgent, "dispatch-1", dispatchArgs),
		toolCallReply(AsyncToolAwaitJob, "await-1", awaitArgs),
		textReply("final with fast research"),
	}}
	rt, ag := newAsyncRuntime(lm, store, &fakeCheckpointStore{})
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, asyncRunCtx(), sink)
	if err != nil {
		t.Fatalf("runInternal: %v", err)
	}
	if result.Status != RunResultCompleted || result.Output != "final with fast research" {
		t.Fatalf("result = (%q, %q), want completed final", result.Status, result.Output)
	}
	if lm.callCount() != 3 {
		t.Fatalf("LLM calls = %d, want 3 without auto-await loop", lm.callCount())
	}
	if len(store.deliveredJobs) != 1 || store.deliveredJobs[0] != "job-1" {
		t.Fatalf("delivered jobs = %v, want [job-1]", store.deliveredJobs)
	}
	for _, msg := range result.NewMessages {
		for _, call := range msg.ToolCalls {
			if call.ID == "auto-await:run-test:job-1" {
				t.Fatalf("unexpected synthetic auto-await after inline await: %+v", result.NewMessages)
			}
		}
	}
}
