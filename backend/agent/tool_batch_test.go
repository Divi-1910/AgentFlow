package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"backend/llm"
	"backend/runtimectx"
	"backend/tools"
)

type batchTool struct {
	name       string
	delay      time.Duration
	content    string
	isError    bool
	err        error
	panicValue any
	onStart    func(string)
	calls      atomic.Int64
}

func (t *batchTool) Name() string { return t.name }

func (t *batchTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.name,
		Description: "test tool",
		Parameters:  json.RawMessage(`{"type":"object","properties":{}}`),
	}
}

func (t *batchTool) Execute(ctx context.Context, call tools.ToolCall) (*tools.ToolResult, error) {
	t.calls.Add(1)
	if t.onStart != nil {
		t.onStart(call.ID)
	}
	if t.delay > 0 {
		timer := time.NewTimer(t.delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
	}
	if t.panicValue != nil {
		panic(t.panicValue)
	}
	if t.err != nil {
		return nil, t.err
	}
	content := t.content
	if content == "" {
		content = fmt.Sprintf("%s:%s", t.name, call.ID)
	}
	return &tools.ToolResult{Content: content, IsError: t.isError}, nil
}

type timeoutBatchTool struct {
	*batchTool
	timeout time.Duration
}

func (t *timeoutBatchTool) Timeout() time.Duration { return t.timeout }

func newRuntimeWithTools(lm llm.LLMClient, store CheckpointStore, testTools ...tools.Tool) (*AgentRuntime, *Agent) {
	llmReg := llm.NewEmptyLLMRegistry()
	llmReg.Register("fake", lm)

	toolReg := tools.NewEmptyRegistry()
	names := make([]string, 0, len(testTools))
	for _, tool := range testTools {
		toolReg.Register(tool)
		names = append(names, tool.Name())
	}

	rt := &AgentRuntime{
		llmRegistry:     llmReg,
		toolRegistry:    toolReg,
		contextBuilder:  newTestContextBuilder(),
		checkpointStore: store,
		capabilities:    ToolCapabilities{AsyncJobs: true},
	}
	ag := &Agent{
		ID:           "agent-a",
		Provider:     "fake",
		Model:        "fake-model",
		Tools:        names,
		SystemPrompt: "You are a test agent.",
		MaxSteps:     5,
	}
	return rt, ag
}

func multiToolCallReply(calls ...llm.ToolCall) fakeReply {
	return fakeReply{resp: llm.ChatResponse{ToolCalls: calls}}
}

func tc(id, name string) llm.ToolCall {
	return llm.ToolCall{ID: id, Name: name, Arguments: json.RawMessage(`{}`)}
}

func delegateTC(id, name, task string) llm.ToolCall {
	args, _ := json.Marshal(map[string]string{"task": task})
	return llm.ToolCall{ID: id, Name: name, Arguments: args}
}

func toolMessages(messages []llm.ChatMessage) []llm.ChatMessage {
	out := make([]llm.ChatMessage, 0)
	for _, m := range messages {
		if m.Role == "tool" {
			out = append(out, m)
		}
	}
	return out
}

func sinkEvents(sink *captureEventSink) []StreamEvent {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	out := make([]StreamEvent, len(sink.events))
	copy(out, sink.events)
	return out
}

func countToolEvents(events []StreamEvent, typ EventType, toolID string) int {
	var count int
	for _, e := range events {
		if e.Type == typ && e.Tool != nil && e.Tool.ID == toolID {
			count++
		}
	}
	return count
}

func TestRunToolBatchRunsIndependentToolsInParallel(t *testing.T) {
	t.Parallel()

	slowA := &batchTool{name: "slow_a", delay: 300 * time.Millisecond}
	slowB := &batchTool{name: "slow_b", delay: 300 * time.Millisecond}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-a", "slow_a"), tc("tc-b", "slow_b")),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, slowA, slowB)

	start := time.Now()
	result, err := rt.Run(context.Background(), ag, newTestRunCtx("run both"))
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Output != "done" {
		t.Fatalf("Output = %q, want done", result.Output)
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("tool batch took %v, want < 500ms for parallel 300ms tools", elapsed)
	}
}

func TestRunToolBatchAppliesTranscriptInCallOrder(t *testing.T) {
	t.Parallel()

	slow := &batchTool{name: "slow_first", delay: 200 * time.Millisecond, content: "slow result"}
	fast := &batchTool{name: "fast_second", delay: 10 * time.Millisecond, content: "fast result"}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-slow", "slow_first"), tc("tc-fast", "fast_second")),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, slow, fast)

	result, err := rt.Run(context.Background(), ag, newTestRunCtx("run both"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("tool messages = %d, want 2: %+v", len(tools), result.NewMessages)
	}
	if tools[0].ToolCallID != "tc-slow" || tools[0].Content != "slow result" {
		t.Fatalf("first tool message = %+v, want slow result", tools[0])
	}
	if tools[1].ToolCallID != "tc-fast" || tools[1].Content != "fast result" {
		t.Fatalf("second tool message = %+v, want fast result", tools[1])
	}
	secondSystem := lm.calls[1].Messages[0].Content
	if !strings.Contains(secondSystem, "last_action: fast_second → success") {
		t.Fatalf("LastAction should track the last outcome in call order, got:\n%s", secondSystem)
	}
}

func TestRunToolBatchExecuteErrorDoesNotStopSibling(t *testing.T) {
	t.Parallel()

	errTool := &batchTool{name: "err_tool", err: errors.New("boom")}
	okTool := &batchTool{name: "ok_tool", content: "ok"}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-err", "err_tool"), tc("tc-ok", "ok_tool")),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, errTool, okTool)
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, newTestRunCtx("run both"), sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("tool messages = %d, want 2: %+v", len(tools), result.NewMessages)
	}
	if tools[0].Content != `[error] tool "err_tool" failed: boom` {
		t.Fatalf("error transcript = %q", tools[0].Content)
	}
	if tools[1].Content != "ok" {
		t.Fatalf("sibling content = %q, want ok", tools[1].Content)
	}

	events := sinkEvents(sink)
	if countToolEvents(events, EventToolFailed, "tc-err") != 1 {
		t.Fatalf("want one tool.failed for err_tool, events: %+v", events)
	}
	if countToolEvents(events, EventToolCompleted, "tc-ok") != 1 {
		t.Fatalf("want one tool.completed for ok_tool, events: %+v", events)
	}
}

func TestRunToolBatchPanicDoesNotStopSibling(t *testing.T) {
	t.Parallel()

	panicTool := &batchTool{name: "panic_tool", panicValue: "boom"}
	okTool := &batchTool{name: "ok_tool", content: "ok"}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-panic", "panic_tool"), tc("tc-ok", "ok_tool")),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, panicTool, okTool)
	runCtx := newTestRunCtx("run both")
	runCtx.Logger = discardLogger()
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("tool messages = %d, want 2", len(tools))
	}
	if !strings.Contains(tools[0].Content, `[error] tool "panic_tool" failed: panic: boom`) {
		t.Fatalf("panic transcript = %q", tools[0].Content)
	}
	if tools[1].Content != "ok" {
		t.Fatalf("sibling content = %q, want ok", tools[1].Content)
	}

	events := sinkEvents(sink)
	if countToolEvents(events, EventToolFailed, "tc-panic") != 1 {
		t.Fatalf("want one tool.failed for panic tool, events: %+v", events)
	}
	if countToolEvents(events, EventToolCompleted, "tc-ok") != 1 {
		t.Fatalf("want one tool.completed for ok tool, events: %+v", events)
	}
}

func TestRunToolBatchThreePanicsFailAfterAllTerminalEvents(t *testing.T) {
	t.Parallel()

	panicTool := &batchTool{name: "panic_tool", panicValue: "boom"}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(
			tc("tc-1", "panic_tool"),
			tc("tc-2", "panic_tool"),
			tc("tc-3", "panic_tool"),
		),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, panicTool)
	runCtx := newTestRunCtx("panic three times")
	runCtx.Logger = discardLogger()
	sink := &captureEventSink{}

	_, err := rt.runInternal(context.Background(), ag, runCtx, sink)
	if err == nil || !strings.Contains(err.Error(), `tool "panic_tool" exceeded failure threshold`) {
		t.Fatalf("error = %v, want failure threshold", err)
	}
	events := sinkEvents(sink)
	for _, id := range []string{"tc-1", "tc-2", "tc-3"} {
		if countToolEvents(events, EventToolStarted, id) != 1 {
			t.Fatalf("want started for %s, events: %+v", id, events)
		}
		if countToolEvents(events, EventToolFailed, id) != 1 {
			t.Fatalf("want failed for %s, events: %+v", id, events)
		}
	}
}

func TestRunToolBatchMissingToolPreflightPreventsSiblingExecution(t *testing.T) {
	t.Parallel()

	var sideEffects atomic.Int64
	okTool := &batchTool{name: "ok_tool", onStart: func(string) { sideEffects.Add(1) }}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-ok", "ok_tool"), tc("tc-missing", "missing_tool")),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, okTool)
	sink := &captureEventSink{}

	_, err := rt.runInternal(context.Background(), ag, newTestRunCtx("run both"), sink)
	if !errors.Is(err, ErrToolNotAvailable) {
		t.Fatalf("err = %v, want ErrToolNotAvailable", err)
	}
	if got := sideEffects.Load(); got != 0 {
		t.Fatalf("valid sibling executed %d times, want 0", got)
	}
	events := sinkEvents(sink)
	if countToolEvents(events, EventToolStarted, "tc-ok") != 0 {
		t.Fatalf("valid sibling should not emit tool.started, events: %+v", events)
	}
	if countToolEvents(events, EventToolStarted, "tc-missing") != 0 {
		t.Fatalf("missing tool should not emit tool.started, events: %+v", events)
	}
	if countToolEvents(events, EventToolFailed, "tc-missing") != 1 {
		t.Fatalf("missing tool should emit one tool.failed, events: %+v", events)
	}
}

func TestRunToolBatchTimeoutDoesNotCancelIndependentSibling(t *testing.T) {
	t.Parallel()

	timeoutTool := &timeoutBatchTool{
		batchTool: &batchTool{name: "timeout_tool", delay: 300 * time.Millisecond},
		timeout:   50 * time.Millisecond,
	}
	normalTool := &batchTool{name: "normal_tool", delay: 300 * time.Millisecond, content: "normal ok"}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-timeout", "timeout_tool"), tc("tc-normal", "normal_tool")),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, timeoutTool, normalTool)
	sink := &captureEventSink{}

	start := time.Now()
	result, err := rt.runInternal(context.Background(), ag, newTestRunCtx("run both"), sink)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("batch took %v, timeout should not serialize or cancel sibling", elapsed)
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("tool messages = %d, want 2", len(tools))
	}
	if !strings.Contains(tools[0].Content, `[error] tool "timeout_tool" failed:`) {
		t.Fatalf("timeout transcript = %q", tools[0].Content)
	}
	if tools[1].Content != "normal ok" {
		t.Fatalf("normal sibling content = %q, want normal ok", tools[1].Content)
	}
	events := sinkEvents(sink)
	if countToolEvents(events, EventToolFailed, "tc-timeout") != 1 {
		t.Fatalf("want timeout tool.failed, events: %+v", events)
	}
	if countToolEvents(events, EventToolCompleted, "tc-normal") != 1 {
		t.Fatalf("want normal tool.completed, events: %+v", events)
	}
}

func TestRunToolBatchCancelMidBatchReturnsCancellationBeforeSecondModelCall(t *testing.T) {
	t.Parallel()

	started := make(chan string, 2)
	blockA := &batchTool{name: "block_a", delay: 5 * time.Second, onStart: func(id string) { started <- id }}
	blockB := &batchTool{name: "block_b", delay: 5 * time.Second, onStart: func(id string) { started <- id }}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-a", "block_a"), tc("tc-b", "block_b")),
		textReply("should not be called"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, blockA, blockB)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := rt.Run(ctx, ag, newTestRunCtx("run both"))
		errCh <- err
	}()

	<-started
	<-started
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("run did not drain batch after cancellation")
	}
	if calls := lm.callCount(); calls != 1 {
		t.Fatalf("LLM calls = %d, want 1; runtime should not apply tools and continue", calls)
	}
}

type cancelOnTerminalSink struct {
	captureEventSink
	cancel func()
	target int32
	seen   atomic.Int32
}

func (s *cancelOnTerminalSink) Emit(e StreamEvent) {
	s.captureEventSink.Emit(e)
	if e.Type == EventToolCompleted || e.Type == EventToolFailed {
		if s.seen.Add(1) == s.target {
			s.cancel()
		}
	}
}

func TestRunToolBatchCancelAfterCompletionBeforeApplySkipsSecondModelCall(t *testing.T) {
	t.Parallel()

	a := &batchTool{name: "tool_a", content: "a"}
	b := &batchTool{name: "tool_b", content: "b"}
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(tc("tc-a", "tool_a"), tc("tc-b", "tool_b")),
		textReply("should not be called"),
	}}
	rt, ag := newRuntimeWithTools(lm, nil, a, b)

	ctx, cancel := context.WithCancel(context.Background())
	sink := &cancelOnTerminalSink{cancel: cancel, target: 2}

	_, err := rt.runInternal(ctx, ag, newTestRunCtx("run both"), sink)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if calls := lm.callCount(); calls != 1 {
		t.Fatalf("LLM calls = %d, want 1; runtime should not apply completed batch after cancellation", calls)
	}
}

func TestRunToolBatchToolResultIsErrorCompletesAndDoesNotCountTowardThreshold(t *testing.T) {
	t.Parallel()

	softErr := &batchTool{name: "soft_error", content: "soft failure", isError: true}
	snap := RunSnapshot{
		Version: 1,
		RunID:   "run-soft-error",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "do it"},
				{Role: "assistant", ToolCalls: []llm.ToolCall{tc("tc-soft", "soft_error")}},
			},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{"soft_error": 2},
		},
		Meta: SnapshotMeta{
			Phase:          PhasePostModel,
			EffectiveTools: ToolRefList{{Name: "soft_error"}},
		},
	}
	lm := &fakeLLM{replies: []fakeReply{textReply("done")}}
	rt, ag := newRuntimeWithTools(lm, nil, softErr)
	runCtx := newTestRunCtx("")
	runCtx.RunID = "run-soft-error"
	runCtx.Checkpoint = &snap
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Output != "done" {
		t.Fatalf("Output = %q, want done", result.Output)
	}
	events := sinkEvents(sink)
	if countToolEvents(events, EventToolCompleted, "tc-soft") != 1 {
		t.Fatalf("IsError result should emit tool.completed, events: %+v", events)
	}
	if countToolEvents(events, EventToolFailed, "tc-soft") != 0 {
		t.Fatalf("IsError result should not emit tool.failed, events: %+v", events)
	}
}

func TestRunToolCallPanicOutcomePreservesMetadataAndFailedEvent(t *testing.T) {
	t.Parallel()

	panicTool := &batchTool{name: "panic_tool", panicValue: "boom"}
	p := plannedCall{
		index:   0,
		call:    llm.ToolCall{ID: "tc-panic", Name: "panic_tool", Arguments: json.RawMessage(`{"x":1}`)},
		tool:    panicTool,
		rawArgs: json.RawMessage(`{"x":1}`),
	}
	runCtx := newTestRunCtx("panic")
	runCtx.Logger = discardLogger()
	sink := &captureEventSink{}

	outcome := runToolCall(context.Background(), runCtx, sink, 1, p, runCtx.Logger)
	if !outcome.ran || !outcome.execFailed {
		t.Fatalf("outcome = %+v, want ran exec failure", outcome)
	}
	if outcome.message.ToolCallID != "tc-panic" {
		t.Fatalf("ToolCallID = %q", outcome.message.ToolCallID)
	}
	if outcome.message.Metadata["tool_name"] != "panic_tool" {
		t.Fatalf("metadata tool_name = %+v", outcome.message.Metadata["tool_name"])
	}
	if outcome.message.Metadata["arguments"] != `{"x":1}` {
		t.Fatalf("metadata arguments = %+v", outcome.message.Metadata["arguments"])
	}
	if outcome.message.Metadata["is_error"] != true {
		t.Fatalf("metadata is_error = %+v", outcome.message.Metadata["is_error"])
	}
	if _, ok := outcome.message.Metadata["latency_ms"].(int64); !ok {
		t.Fatalf("metadata latency_ms missing or wrong type: %+v", outcome.message.Metadata["latency_ms"])
	}

	events := sinkEvents(sink)
	if countToolEvents(events, EventToolFailed, "tc-panic") != 1 {
		t.Fatalf("want one failed event, events: %+v", events)
	}
	for _, e := range events {
		if e.Type != EventToolFailed {
			continue
		}
		if e.Tool == nil || e.Tool.ID != "tc-panic" || e.Tool.Name != "panic_tool" || string(e.Tool.Args) != `{"x":1}` {
			t.Fatalf("failed event tool metadata = %+v", e.Tool)
		}
		if e.Error == nil || e.Error.Code != "tool.execution_failed" || e.Error.Message != "panic: boom" {
			t.Fatalf("failed event error = %+v", e.Error)
		}
		return
	}
}

type timingDelegateInvoker struct {
	mu             sync.Mutex
	delayByTarget  map[string]time.Duration
	panicByTask    map[string]any
	activeByTarget map[string]int
	maxByTarget    map[string]int
	activeGlobal   int
	maxGlobal      int
}

func newTimingDelegateInvoker() *timingDelegateInvoker {
	return &timingDelegateInvoker{
		delayByTarget:  make(map[string]time.Duration),
		panicByTask:    make(map[string]any),
		activeByTarget: make(map[string]int),
		maxByTarget:    make(map[string]int),
	}
}

func (i *timingDelegateInvoker) InvokeDelegate(ctx context.Context, _ runtimectx.DelegationInfo, target, task, _ string) (string, error) {
	i.mu.Lock()
	i.activeGlobal++
	if i.activeGlobal > i.maxGlobal {
		i.maxGlobal = i.activeGlobal
	}
	i.activeByTarget[target]++
	if i.activeByTarget[target] > i.maxByTarget[target] {
		i.maxByTarget[target] = i.activeByTarget[target]
	}
	i.mu.Unlock()

	defer func() {
		i.mu.Lock()
		i.activeByTarget[target]--
		i.activeGlobal--
		i.mu.Unlock()
	}()

	if d := i.delayByTarget[target]; d > 0 {
		timer := time.NewTimer(d)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		}
	}
	if p, ok := i.panicByTask[task]; ok {
		panic(p)
	}
	return fmt.Sprintf("%s:%s", target, task), nil
}

func (i *timingDelegateInvoker) maxConcurrencyFor(target string) int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.maxByTarget[target]
}

func (i *timingDelegateInvoker) maxGlobalConcurrency() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.maxGlobal
}

func newRuntimeWithDelegates(lm llm.LLMClient, inv DelegateInvoker, delegates []DelegateConfig) (*AgentRuntime, *Agent) {
	llmReg := llm.NewEmptyLLMRegistry()
	llmReg.Register("fake", lm)
	rt := &AgentRuntime{
		llmRegistry:    llmReg,
		toolRegistry:   tools.NewEmptyRegistry(),
		contextBuilder: newTestContextBuilder(),
		capabilities:   ToolCapabilities{AsyncJobs: true},
	}
	rt.SetDelegateInvoker(inv)
	ag := &Agent{
		ID:           "agent-a",
		Provider:     "fake",
		Model:        "fake-model",
		Delegates:    delegates,
		SystemPrompt: "You are a test agent.",
		MaxSteps:     5,
	}
	return rt, ag
}

func TestRunToolBatchDelegatesDifferentTargetsRunInParallel(t *testing.T) {
	t.Parallel()

	inv := newTimingDelegateInvoker()
	inv.delayByTarget["agent-b"] = 300 * time.Millisecond
	inv.delayByTarget["agent-c"] = 300 * time.Millisecond
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(
			delegateTC("tc-b", "ask_b", "one"),
			delegateTC("tc-c", "ask_c", "two"),
		),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithDelegates(lm, inv, []DelegateConfig{
		{AgentID: "agent-b", ToolName: "ask_b", Description: "ask b"},
		{AgentID: "agent-c", ToolName: "ask_c", Description: "ask c"},
	})

	start := time.Now()
	result, err := rt.Run(context.Background(), ag, newTestRunCtx("delegate both"))
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("delegate batch took %v, want < 500ms for two 300ms targets", elapsed)
	}
	if inv.maxGlobalConcurrency() < 2 {
		t.Fatalf("delegate invoker max global concurrency = %d, want at least 2", inv.maxGlobalConcurrency())
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 || tools[0].Content != "agent-b:one" || tools[1].Content != "agent-c:two" {
		t.Fatalf("tool messages out of call order: %+v", tools)
	}
}

func TestRunToolBatchDelegatesSameTargetSerializeAcrossToolNames(t *testing.T) {
	t.Parallel()

	inv := newTimingDelegateInvoker()
	inv.delayByTarget["agent-b"] = 150 * time.Millisecond
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(
			delegateTC("tc-b1", "ask_b_one", "one"),
			delegateTC("tc-b2", "ask_b_two", "two"),
		),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithDelegates(lm, inv, []DelegateConfig{
		{AgentID: "agent-b", ToolName: "ask_b_one", Description: "ask b one"},
		{AgentID: "agent-b", ToolName: "ask_b_two", Description: "ask b two"},
	})

	start := time.Now()
	result, err := rt.Run(context.Background(), ag, newTestRunCtx("delegate both"))
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if elapsed < 280*time.Millisecond {
		t.Fatalf("same-target delegates took %v, want serialized duration", elapsed)
	}
	if max := inv.maxConcurrencyFor("agent-b"); max > 1 {
		t.Fatalf("same target max concurrency = %d, want <= 1", max)
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 || tools[0].Content != "agent-b:one" || tools[1].Content != "agent-b:two" {
		t.Fatalf("tool messages out of call order: %+v", tools)
	}
}

func TestRunToolBatchSameTargetDelegateGroupContinuesAfterPanic(t *testing.T) {
	t.Parallel()

	inv := newTimingDelegateInvoker()
	inv.panicByTask["panic"] = "boom"
	lm := &fakeLLM{replies: []fakeReply{
		multiToolCallReply(
			delegateTC("tc-panic", "ask_b_one", "panic"),
			delegateTC("tc-ok", "ask_b_two", "ok"),
		),
		textReply("done"),
	}}
	rt, ag := newRuntimeWithDelegates(lm, inv, []DelegateConfig{
		{AgentID: "agent-b", ToolName: "ask_b_one", Description: "ask b one"},
		{AgentID: "agent-b", ToolName: "ask_b_two", Description: "ask b two"},
	})
	runCtx := newTestRunCtx("delegate both")
	runCtx.Logger = discardLogger()
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if max := inv.maxConcurrencyFor("agent-b"); max > 1 {
		t.Fatalf("same target max concurrency = %d, want <= 1", max)
	}
	tools := toolMessages(result.NewMessages)
	if len(tools) != 2 {
		t.Fatalf("tool messages = %d, want 2", len(tools))
	}
	if !strings.Contains(tools[0].Content, `[error] tool "ask_b_one" failed: panic: boom`) {
		t.Fatalf("first delegate transcript = %q", tools[0].Content)
	}
	if tools[1].Content != "agent-b:ok" {
		t.Fatalf("second delegate content = %q, want agent-b:ok", tools[1].Content)
	}
	events := sinkEvents(sink)
	if countToolEvents(events, EventToolFailed, "tc-panic") != 1 {
		t.Fatalf("want failed event for panic delegate, events: %+v", events)
	}
	if countToolEvents(events, EventToolCompleted, "tc-ok") != 1 {
		t.Fatalf("want completed event for second delegate, events: %+v", events)
	}
}

func TestApplyToolOutcomesSetsLastActionFromLastCallInOrder(t *testing.T) {
	t.Parallel()

	successOutcome := func(index int, name, callID string) toolOutcome {
		return toolOutcome{
			index:    index,
			toolName: name,
			message: llm.ChatMessage{
				Role:       "tool",
				ToolCallID: callID,
				Content:    "ok",
				Metadata:   map[string]any{"tool_name": name, "is_error": false},
			},
			lastAction: fmt.Sprintf("%s → success", name),
			ran:        true,
		}
	}
	failureOutcome := func(index int, name, callID string) toolOutcome {
		return failedToolOutcome(plannedCall{
			index: index,
			call:  llm.ToolCall{ID: callID, Name: name, Arguments: json.RawMessage(`{}`)},
		}, 5, "boom")
	}

	cases := []struct {
		name     string
		outcomes []toolOutcome
		want     string
	}{
		{
			name:     "failure first, success last → last wins",
			outcomes: []toolOutcome{failureOutcome(0, "first_tool", "tc-1"), successOutcome(1, "second_tool", "tc-2")},
			want:     "second_tool → success",
		},
		{
			name:     "success first, failure last → last wins",
			outcomes: []toolOutcome{successOutcome(0, "first_tool", "tc-1"), failureOutcome(1, "second_tool", "tc-2")},
			want:     "second_tool → error",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var messages, newMessages []llm.ChatMessage
			runCtx := newTestRunCtx("apply")
			if err := applyToolOutcomes(&messages, &newMessages, map[string]int{}, &runCtx, c.outcomes); err != nil {
				t.Fatalf("applyToolOutcomes: %v", err)
			}
			if runCtx.LastAction != c.want {
				t.Fatalf("LastAction = %q, want %q (last call in call order)", runCtx.LastAction, c.want)
			}
			// Live LastAction must agree with what a resume re-derives from the
			// transcript (deriveLastActionFromMessages walks newest-first) — the
			// consistency D7 exists to protect.
			if derived := deriveLastActionFromMessages(messages); derived != runCtx.LastAction {
				t.Fatalf("live LastAction %q != resume-derived %q", runCtx.LastAction, derived)
			}
		})
	}
}

func TestResumeFromPostModelWithMultiplePendingCallsUsesParallelBatch(t *testing.T) {
	t.Parallel()

	a := &batchTool{name: "slow_a", delay: 300 * time.Millisecond}
	b := &batchTool{name: "slow_b", delay: 300 * time.Millisecond}
	snap := RunSnapshot{
		Version: 1,
		RunID:   "run-resume-parallel",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "run both"},
				{Role: "assistant", ToolCalls: []llm.ToolCall{
					tc("tc-a", "slow_a"),
					tc("tc-b", "slow_b"),
				}},
			},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{},
		},
		Meta: SnapshotMeta{
			Phase:          PhasePostModel,
			EffectiveTools: ToolRefList{{Name: "slow_a"}, {Name: "slow_b"}},
		},
	}
	lm := &fakeLLM{replies: []fakeReply{textReply("done")}}
	rt, ag := newRuntimeWithTools(lm, nil, a, b)
	runCtx := newTestRunCtx("")
	runCtx.RunID = "run-resume-parallel"
	runCtx.Checkpoint = &snap

	start := time.Now()
	result, err := rt.Run(context.Background(), ag, runCtx)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Output != "done" {
		t.Fatalf("Output = %q, want done", result.Output)
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("post_model resume batch took %v, want < 500ms for parallel 300ms tools", elapsed)
	}
}
