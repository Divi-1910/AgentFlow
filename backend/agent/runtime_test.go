package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/llm"
	"backend/tools"
)

// ── Fakes ─────────────────────────────────────────────────────────────────────

// fakeReply is a single scripted response from fakeLLM.
type fakeReply struct {
	resp llm.ChatResponse
	err  error
}

// fakeLLM replays a fixed sequence of replies. Thread-safe.
type fakeLLM struct {
	mu      sync.Mutex
	replies []fakeReply
	calls   []*llm.ChatRequest
	idx     int
}

func (f *fakeLLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, req)
	if len(f.replies) == 0 {
		return &llm.ChatResponse{}, errors.New("fakeLLM: no replies configured")
	}
	if f.idx >= len(f.replies) {
		// Repeat the last reply — makes "always tool call" tests easy.
		r := f.replies[len(f.replies)-1]
		return &r.resp, r.err
	}
	r := f.replies[f.idx]
	f.idx++
	return &r.resp, r.err
}

func (f *fakeLLM) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// fakeCheckpointStore records every Save call and returns errors from a queue.
// All other methods are no-ops unless overridden via fields.
type fakeCheckpointStore struct {
	mu            sync.Mutex
	saves         []RunSnapshot
	saveErrs      []error // sequential: saveErrs[i] returned on i-th Save call
	saveCallCount int
	statusUpdates []statusUpdate
}

type statusUpdate struct {
	runID  string
	status string
}

func (s *fakeCheckpointStore) Save(_ context.Context, snap RunSnapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := s.saveCallCount
	s.saveCallCount++
	s.saves = append(s.saves, snap)
	if idx < len(s.saveErrs) {
		return s.saveErrs[idx]
	}
	return nil
}

func (s *fakeCheckpointStore) UpdateStatus(_ context.Context, runID, status, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statusUpdates = append(s.statusUpdates, statusUpdate{runID: runID, status: status})
	return nil
}

func (s *fakeCheckpointStore) phases() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.saves))
	for i, snap := range s.saves {
		out[i] = snap.Meta.Phase
	}
	return out
}

// Remaining CheckpointStore methods — all no-ops for tests that don't need them.
func (s *fakeCheckpointStore) CreateRun(_ context.Context, _, _, _, _ string) error { return nil }
func (s *fakeCheckpointStore) LoadLatest(_ context.Context, _ string) (*RunSnapshot, error) {
	return nil, nil
}
func (s *fakeCheckpointStore) TransitionStatus(_ context.Context, _, _, _ string) (bool, error) {
	return false, nil
}
func (s *fakeCheckpointStore) TransitionStatusForUser(_ context.Context, _, _, _, _ string) (bool, error) {
	return false, nil
}
func (s *fakeCheckpointStore) IncrementAttempt(_ context.Context, _ string) (int, error) {
	return 1, nil
}
func (s *fakeCheckpointStore) GetRun(_ context.Context, _ string) (*RunInfo, error) { return nil, nil }
func (s *fakeCheckpointStore) GetRunForUser(_ context.Context, _, _ string) (*RunInfo, error) {
	return nil, nil
}

// captureEventSink collects every emitted event for assertion.
type captureEventSink struct {
	mu     sync.Mutex
	events []StreamEvent
}

func (s *captureEventSink) Emit(e StreamEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, e)
}
func (s *captureEventSink) Close() {}

func (s *captureEventSink) types() []EventType {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]EventType, len(s.events))
	for i, e := range s.events {
		out[i] = e.Type
	}
	return out
}

func (s *captureEventSink) has(et EventType) bool {
	for _, t := range s.types() {
		if t == et {
			return true
		}
	}
	return false
}

// panicOnCallLLM panics inside ChatCompletion to test runtime panic recovery.
type panicOnCallLLM struct{}

func (p *panicOnCallLLM) ChatCompletion(_ context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
	panic("simulated LLM panic")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func newTestRuntime(lm llm.LLMClient, store CheckpointStore) (*AgentRuntime, *Agent) {
	llmReg := llm.NewEmptyLLMRegistry()
	llmReg.Register("fake", lm)

	toolReg := tools.NewEmptyRegistry()
	toolReg.Register(tools.NewCalculatorTool())

	rt := &AgentRuntime{
		llmRegistry:     llmReg,
		toolRegistry:    toolReg,
		contextBuilder:  newTestContextBuilder(),
		checkpointStore: store,
		capabilities:    ToolCapabilities{AsyncJobs: true},
	}
	ag := &Agent{
		Provider:     "fake",
		Model:        "fake-model",
		Tools:        []string{"calculator"},
		SystemPrompt: "You are a test agent.",
		MaxSteps:     5,
	}
	return rt, ag
}

// newTestContextBuilder constructs a ContextBuilder that is safe for unit
// tests: no platform XML beyond a stub, no memory backend. The builder skips
// memory and preference layers when those backends are nil, so it produces a
// minimal but well-formed system message. Tool instructions now come from the
// per-run tool definitions passed into Build, not from the builder.
func newTestContextBuilder() *ContextBuilder {
	return &ContextBuilder{
		platform: &PlatformConfig{Body: "<platform>test platform</platform>"},
		now:      func() time.Time { return time.Date(2026, 5, 17, 12, 0, 0, 0, time.UTC) },
	}
}

func newTestRunCtx(input string) RunContext {
	return RunContext{
		RunID: "run-test",
		Input: input,
	}
}

// discardLogger returns a logger that silently drops all output.
// Use it in direct trySaveCheckpoint calls to avoid slog output in test runs.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func textReply(content string) fakeReply {
	return fakeReply{resp: llm.ChatResponse{Content: content}}
}

func toolCallReply(toolName, callID string, args json.RawMessage) fakeReply {
	return fakeReply{
		resp: llm.ChatResponse{
			ToolCalls: []llm.ToolCall{{ID: callID, Name: toolName, Arguments: args}},
		},
	}
}

func errReply(err error) fakeReply {
	return fakeReply{err: err}
}

// ── Single-step text response ─────────────────────────────────────────────────

func TestRunSingleStepTextResponseReturnsCorrectOutput(t *testing.T) {
	t.Parallel()
	lm := &fakeLLM{replies: []fakeReply{textReply("hello world")}}
	rt, ag := newTestRuntime(lm, nil)

	result, err := rt.Run(context.Background(), ag, newTestRunCtx("say hello"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Output != "hello world" {
		t.Errorf("Output: got %q, want %q", result.Output, "hello world")
	}
	if result.Steps != 1 {
		t.Errorf("Steps: got %d, want 1", result.Steps)
	}
	if lm.callCount() != 1 {
		t.Errorf("LLM calls: got %d, want 1", lm.callCount())
	}
}

// ── Event order ───────────────────────────────────────────────────────────────

func TestRunSingleStepEmitsEventsInOrder(t *testing.T) {
	t.Parallel()
	lm := &fakeLLM{replies: []fakeReply{textReply("done")}}
	rt, ag := newTestRuntime(lm, nil)
	sink := &captureEventSink{}

	result, err := rt.runInternal(context.Background(), ag, newTestRunCtx("hi"), sink)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("result is nil")
	}

	want := []EventType{
		EventRunStarted,
		EventStepStarted,
		EventStatusUpdated,
		EventModelCompleted,
		EventStepCompleted,
		EventRunCompleted,
	}
	got := sink.types()
	if len(got) != len(want) {
		t.Fatalf("event count: got %d, want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
	}
	for i, et := range want {
		if got[i] != et {
			t.Errorf("event[%d]: got %q, want %q", i, got[i], et)
		}
	}
}

// ── Tool call → final answer ──────────────────────────────────────────────────

func TestRunToolCallFollowedByFinalAnswerCompletesInTwoSteps(t *testing.T) {
	t.Parallel()
	calcArgs := json.RawMessage(`{"expression":"2+2"}`)
	lm := &fakeLLM{replies: []fakeReply{
		toolCallReply("calculator", "tc-1", calcArgs),
		textReply("The answer is 4."),
	}}
	rt, ag := newTestRuntime(lm, nil)

	result, err := rt.Run(context.Background(), ag, newTestRunCtx("what is 2+2?"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Steps != 2 {
		t.Errorf("Steps: got %d, want 2", result.Steps)
	}
	if lm.callCount() != 2 {
		t.Errorf("LLM calls: got %d, want 2", lm.callCount())
	}
	if result.Output != "The answer is 4." {
		t.Errorf("Output: got %q", result.Output)
	}
}

// ── Max steps ─────────────────────────────────────────────────────────────────

func TestRunMaxStepsExhaustedReturnsErrMaxStepsReached(t *testing.T) {
	t.Parallel()
	calcArgs := json.RawMessage(`{"expression":"1+1"}`)
	// Provide 5 replies (== MaxSteps); each triggers a tool call so the loop never exits cleanly.
	lm := &fakeLLM{replies: []fakeReply{
		toolCallReply("calculator", "tc-1", calcArgs),
		toolCallReply("calculator", "tc-2", calcArgs),
		toolCallReply("calculator", "tc-3", calcArgs),
	}}
	rt, ag := newTestRuntime(lm, nil)
	ag.MaxSteps = 3

	_, err := rt.Run(context.Background(), ag, newTestRunCtx("loop forever"))

	if !errors.Is(err, ErrMaxStepsReached) {
		t.Errorf("want ErrMaxStepsReached, got: %v", err)
	}
}

// ── LLM error ─────────────────────────────────────────────────────────────────

func TestRunLLMErrorReturnsFailed(t *testing.T) {
	t.Parallel()
	lm := &fakeLLM{replies: []fakeReply{errReply(errors.New("model overloaded"))}}
	rt, ag := newTestRuntime(lm, nil)

	_, err := rt.Run(context.Background(), ag, newTestRunCtx("fail"))

	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "llm call failed") {
		t.Errorf("error should mention llm call failed, got: %v", err)
	}
}

// ── Cancelled context ─────────────────────────────────────────────────────────

func TestRunCancelledContextReturnsContextCanceled(t *testing.T) {
	t.Parallel()
	lm := &fakeLLM{replies: []fakeReply{textReply("never reached")}}
	rt, ag := newTestRuntime(lm, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before calling Run

	_, err := rt.Run(ctx, ag, newTestRunCtx("hi"))

	if !errors.Is(err, context.Canceled) {
		t.Errorf("want context.Canceled, got: %v", err)
	}
}

// ── Empty LLM content ─────────────────────────────────────────────────────────

func TestRunEmptyLLMContentReturnsErrNoFinalOutput(t *testing.T) {
	t.Parallel()
	lm := &fakeLLM{replies: []fakeReply{textReply("   \n  ")}} // whitespace only
	rt, ag := newTestRuntime(lm, nil)

	_, err := rt.Run(context.Background(), ag, newTestRunCtx("blank"))

	if !errors.Is(err, ErrNoFinalOutput) {
		t.Errorf("want ErrNoFinalOutput, got: %v", err)
	}
}

// ── Unregistered tool request ─────────────────────────────────────────────────

func TestRunUnregisteredToolRequestReturnsErrToolNotAvailable(t *testing.T) {
	t.Parallel()
	lm := &fakeLLM{replies: []fakeReply{
		toolCallReply("nonexistent_tool", "tc-1", json.RawMessage(`{}`)),
	}}
	rt, ag := newTestRuntime(lm, nil)

	_, err := rt.Run(context.Background(), ag, newTestRunCtx("use missing tool"))

	if !errors.Is(err, ErrToolNotAvailable) {
		t.Errorf("want ErrToolNotAvailable, got: %v", err)
	}
}

// ── Panic recovery ────────────────────────────────────────────────────────────

func TestRunPanicInLLMIsRecoveredAndReturnsError(t *testing.T) {
	t.Parallel()
	rt, ag := newTestRuntime(&panicOnCallLLM{}, nil)

	_, err := rt.Run(context.Background(), ag, newTestRunCtx("panic please"))

	if err == nil {
		t.Fatal("want error from panic recovery, got nil")
	}
	if !strings.Contains(err.Error(), "panic in runtime") {
		t.Errorf("error should mention panic in runtime, got: %v", err)
	}
}

// ── trySaveCheckpoint: success resets failure counter ────────────────────────

func TestTrySaveCheckpointSuccessResetsFailureCounter(t *testing.T) {
	t.Parallel()
	rt, _ := newTestRuntime(&fakeLLM{}, nil)
	store := &fakeCheckpointStore{} // always returns nil on Save
	rt.checkpointStore = store

	snap := minimalSnapshot()
	snap.RunID = "run-reset"

	// Simulate 5 prior consecutive failures; a successful save should reset to 0.
	newFailures, err := rt.trySaveCheckpoint(snap, &captureEventSink{}, 0, 5, true, discardLogger())

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if newFailures != 0 {
		t.Errorf("failures after success: got %d, want 0", newFailures)
	}
}

// ── trySaveCheckpoint: first two fail, third succeeds ────────────────────────

func TestTrySaveCheckpointFirstTwoAttemptsFailThirdSucceedsResetsCounter(t *testing.T) {
	// Note: this test sleeps ~225ms for the two retry backoffs (75ms + 150ms).
	t.Parallel()
	saveErr := errors.New("transient write error")
	store := &fakeCheckpointStore{
		saveErrs: []error{saveErr, saveErr, nil}, // fail, fail, succeed
	}
	rt, _ := newTestRuntime(&fakeLLM{}, nil)
	rt.checkpointStore = store

	snap := minimalSnapshot()
	snap.RunID = "run-retry"

	newFailures, err := rt.trySaveCheckpoint(snap, &captureEventSink{}, 0, 0, false, discardLogger())

	if err != nil {
		t.Fatalf("unexpected error after eventual success: %v", err)
	}
	if newFailures != 0 {
		t.Errorf("failures after eventual success: got %d, want 0", newFailures)
	}
	if store.saveCallCount != 3 {
		t.Errorf("Save call count: got %d, want 3", store.saveCallCount)
	}
}

// ── trySaveCheckpoint: all attempts fail, below threshold ────────────────────

func TestTrySaveCheckpointAllAttemptsFailBelowThresholdRunContinues(t *testing.T) {
	// Note: this test sleeps ~225ms for the two retry backoffs.
	t.Parallel()
	saveErr := errors.New("disk full")
	store := &fakeCheckpointStore{
		saveErrs: []error{saveErr, saveErr, saveErr},
	}
	rt, _ := newTestRuntime(&fakeLLM{}, nil)
	rt.checkpointStore = store

	snap := minimalSnapshot()
	snap.RunID = "run-below-threshold"

	// Start at failures=0; after all 3 attempts fail, failures becomes 1 (<threshold of 3).
	newFailures, err := rt.trySaveCheckpoint(snap, &captureEventSink{}, 0, 0, false, discardLogger())

	if err != nil {
		t.Errorf("want nil error below threshold, got: %v", err)
	}
	if newFailures != 1 {
		t.Errorf("failures: got %d, want 1", newFailures)
	}
}

// ── trySaveCheckpoint: threshold crossed, has prior snapshot ─────────────────

func TestTrySaveCheckpointThresholdCrossedWithPriorSnapshotReturnsErrCheckpointStoreUnavailable(t *testing.T) {
	// Note: sleeps ~225ms for retry backoffs.
	t.Parallel()
	saveErr := errors.New("store down")
	store := &fakeCheckpointStore{
		saveErrs: []error{saveErr, saveErr, saveErr},
	}
	rt, _ := newTestRuntime(&fakeLLM{}, nil)
	rt.checkpointStore = store

	snap := minimalSnapshot()
	snap.RunID = "run-threshold"

	// Start at failures = checkpointFailureThreshold - 1 = 2.
	// After this call fails all 3 attempts: failures becomes 3 → threshold crossed.
	// hasSnapshot=true → must wrap ErrCheckpointStoreUnavailable.
	_, err := rt.trySaveCheckpoint(snap, &captureEventSink{}, 0, checkpointFailureThreshold-1, true, discardLogger())

	if !errors.Is(err, ErrCheckpointStoreUnavailable) {
		t.Errorf("want ErrCheckpointStoreUnavailable, got: %v", err)
	}
}

// ── trySaveCheckpoint: threshold crossed, never saved ────────────────────────

func TestTrySaveCheckpointThresholdCrossedNeverSavedReturnsPlainError(t *testing.T) {
	// Note: sleeps ~225ms for retry backoffs.
	t.Parallel()
	saveErr := errors.New("store down")
	store := &fakeCheckpointStore{
		saveErrs: []error{saveErr, saveErr, saveErr},
	}
	rt, _ := newTestRuntime(&fakeLLM{}, nil)
	rt.checkpointStore = store

	snap := minimalSnapshot()
	snap.RunID = "run-never-saved"

	// hasSnapshot=false → plain error, NOT ErrCheckpointStoreUnavailable.
	_, err := rt.trySaveCheckpoint(snap, &captureEventSink{}, 0, checkpointFailureThreshold-1, false, discardLogger())

	if err == nil {
		t.Fatal("want error, got nil")
	}
	if errors.Is(err, ErrCheckpointStoreUnavailable) {
		t.Errorf("want plain error (no prior snapshot), got ErrCheckpointStoreUnavailable: %v", err)
	}
}

// ── Checkpoint phase sequence ─────────────────────────────────────────────────

func TestCheckpointPhasesFireInCorrectOrderForToolCallStep(t *testing.T) {
	t.Parallel()
	calcArgs := json.RawMessage(`{"expression":"1+1"}`)
	lm := &fakeLLM{replies: []fakeReply{
		toolCallReply("calculator", "tc-1", calcArgs),
		textReply("Done."),
	}}
	store := &fakeCheckpointStore{}
	rt, ag := newTestRuntime(lm, store)

	_, err := rt.Run(context.Background(), ag, newTestRunCtx("what is 1+1?"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{PhasePreModel, PhasePostModel, PhasePreModel, PhaseStepCompleted}
	got := store.phases()
	if len(got) != len(want) {
		t.Fatalf("checkpoint count: got %d, want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
	}
	for i, phase := range want {
		if got[i] != phase {
			t.Errorf("checkpoint[%d]: got %q, want %q", i, got[i], phase)
		}
	}
}

// ── Resume from post_model ────────────────────────────────────────────────────

func TestResumeFromPostModelPhaseSkipsInitialLLMCall(t *testing.T) {
	t.Parallel()

	// Build a snapshot that ended at post_model — the assistant called the calculator.
	snap := RunSnapshot{
		Version: 1,
		RunID:   "run-resume",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "what is 2+2?"},
				{
					Role: "assistant",
					ToolCalls: []llm.ToolCall{{
						ID:        "tc-resume",
						Name:      "calculator",
						Arguments: json.RawMessage(`{"expression":"2+2"}`),
					}},
				},
			},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{},
		},
		Meta: SnapshotMeta{
			Phase:          PhasePostModel,
			EffectiveTools: ToolRefList{{Name: "calculator"}},
		},
	}

	// Only one LLM reply needed: the final answer after tool execution.
	lm := &fakeLLM{replies: []fakeReply{textReply("The answer is 4.")}}
	rt, ag := newTestRuntime(lm, nil)
	sink := &captureEventSink{}

	runCtx := newTestRunCtx("") // input is empty; history comes from snapshot
	runCtx.RunID = "run-resume"
	runCtx.Checkpoint = &snap

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if lm.callCount() != 1 {
		t.Errorf("LLM calls: got %d, want 1 (tool execution skips initial LLM)", lm.callCount())
	}
	if result.Steps != 2 {
		t.Errorf("Steps: got %d, want 2", result.Steps)
	}
	if !sink.has(EventRunResumed) {
		t.Error("want EventRunResumed emitted, not found")
	}
}

// ── Resume from pre_model ─────────────────────────────────────────────────────

func TestResumeFromPreModelPhaseCallsLLMNormally(t *testing.T) {
	t.Parallel()

	snap := RunSnapshot{
		Version: 1,
		RunID:   "run-resume-pre",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "hello"},
				{Role: "assistant", Content: "got it"},
			},
			StepsCompleted: 1,
			MaxSteps:       5,
			ToolFailures:   map[string]int{},
		},
		Meta: SnapshotMeta{
			Phase:          PhasePreModel,
			EffectiveTools: ToolRefList{{Name: "calculator"}},
		},
	}

	lm := &fakeLLM{replies: []fakeReply{textReply("Resumed fine.")}}
	rt, ag := newTestRuntime(lm, nil)
	sink := &captureEventSink{}

	runCtx := newTestRunCtx("")
	runCtx.RunID = "run-resume-pre"
	runCtx.Checkpoint = &snap

	result, err := rt.runInternal(context.Background(), ag, runCtx, sink)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if lm.callCount() != 1 {
		t.Errorf("LLM calls: got %d, want 1", lm.callCount())
	}
	if result.Steps != 2 {
		t.Errorf("Steps: got %d, want 2", result.Steps)
	}
	if !sink.has(EventRunResumed) {
		t.Error("want EventRunResumed emitted, not found")
	}
}

// ── Runtime exposes the builder's system-prompt estimate ─────────────────────

func TestRuntimeEstimateSystemPromptTokensDelegatesToBuilder(t *testing.T) {
	t.Parallel()
	rt, ag := newTestRuntime(&fakeLLM{}, nil)
	rc := newTestRunCtx("hello")

	got := rt.EstimateSystemPromptTokens(context.Background(), ag, rc)
	if got <= 0 {
		t.Errorf("expected a positive estimate from the wired ContextBuilder, got %d", got)
	}
	// And: the same call without a wired builder returns 0 so the message
	// handler falls back to the heuristic.
	bare := &AgentRuntime{}
	if got := bare.EstimateSystemPromptTokens(context.Background(), ag, rc); got != 0 {
		t.Errorf("expected 0 when contextBuilder is nil, got %d", got)
	}
}

// ── Resumed run advances step in <state> (regression for review issue #1) ────

func TestRuntimeOnResumeStateAdvancesPastSnapshotStep(t *testing.T) {
	t.Parallel()
	// Snapshot at step 2, with a tool message so we can also verify
	// LastAction is reconstructed. Resume continues with another tool call
	// then a final answer, producing two more LLM calls (step 3 and step 4).
	snap := RunSnapshot{
		Version: 1,
		RunID:   "run-resume-step",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "compute things"},
				{Role: "assistant", Content: "first call", ToolCalls: []llm.ToolCall{{ID: "tc-a", Name: "calculator"}}},
				{Role: "tool", ToolCallID: "tc-a", Content: "Result: 1",
					Metadata: map[string]any{"tool_name": "calculator", "is_error": false}},
			},
			StepsCompleted: 2,
			MaxSteps:       10,
			ToolFailures:   map[string]int{},
		},
		Meta: SnapshotMeta{Phase: PhasePreModel, EffectiveTools: ToolRefList{{Name: "calculator"}}},
	}

	lm := &fakeLLM{
		replies: []fakeReply{
			toolCallReply("calculator", "tc-b", json.RawMessage(`{"expression":"2+2"}`)),
			textReply("done"),
		},
	}
	rt, ag := newTestRuntime(lm, nil)
	ag.MaxSteps = 10

	runCtx := newTestRunCtx("")
	runCtx.RunID = "run-resume-step"
	runCtx.Checkpoint = &snap

	if _, err := rt.runInternal(context.Background(), ag, runCtx, &captureEventSink{}); err != nil {
		t.Fatalf("runInternal: %v", err)
	}
	if lm.callCount() != 2 {
		t.Fatalf("expected 2 LLM calls on resume, got %d", lm.callCount())
	}

	first := lm.calls[0].Messages[0].Content
	second := lm.calls[1].Messages[0].Content

	// First call after resume: state must reflect step 2 (snapshot value),
	// AND LastAction must be reconstructed from the snapshot tool message.
	if !strings.Contains(first, "step: 2/") {
		t.Errorf("first resumed call should report step 2, got:\n%s", first)
	}
	if !strings.Contains(first, "last_action: calculator → success") {
		t.Errorf("first resumed call should reconstruct LastAction, got:\n%s", first)
	}
	// Second call: step must advance past snapshot value.
	if !strings.Contains(second, "step: 3/") {
		t.Errorf("second resumed call should report step 3 (advanced past snapshot), got:\n%s", second)
	}
}

// ── Dynamic state refresh between LLM calls (regression for review issue #1) ─

func TestRuntimeRefreshesStateBetweenLLMCalls(t *testing.T) {
	t.Parallel()
	// First reply: a tool call. Second reply: a final answer.
	lm := &fakeLLM{
		replies: []fakeReply{
			toolCallReply("calculator", "tc-1", json.RawMessage(`{"expression":"1+1"}`)),
			textReply("done"),
		},
	}
	rt, ag := newTestRuntime(lm, nil)
	runCtx := newTestRunCtx("compute 1+1")

	if _, err := rt.Run(context.Background(), ag, runCtx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if lm.callCount() != 2 {
		t.Fatalf("expected 2 LLM calls, got %d", lm.callCount())
	}

	first := lm.calls[0].Messages[0].Content
	second := lm.calls[1].Messages[0].Content

	if !strings.Contains(first, "step: 0/") {
		t.Errorf("first call should report step 0, content:\n%s", first)
	}
	if !strings.Contains(second, "step: 1/") {
		t.Errorf("second call should report step 1, content:\n%s", second)
	}
	// last_action must appear only after a tool has executed.
	if strings.Contains(first, "last_action") {
		t.Errorf("first call should not yet have last_action: %s", first)
	}
	if !strings.Contains(second, "last_action: calculator → success") {
		t.Errorf("second call should report last_action: calculator → success, got:\n%s", second)
	}
}

// ── classifyError ─────────────────────────────────────────────────────────────

func TestClassifyError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "nil returns engine.runtime_error",
			err:  nil,
			want: "engine.runtime_error",
		},
		{
			name: "ErrMaxStepsReached",
			err:  ErrMaxStepsReached,
			want: "engine.max_steps",
		},
		{
			name: "wrapped ErrMaxStepsReached",
			err:  errors.Join(errors.New("outer"), ErrMaxStepsReached),
			want: "engine.max_steps",
		},
		{
			name: "ErrNoFinalOutput",
			err:  ErrNoFinalOutput,
			want: "engine.no_output",
		},
		{
			name: "ErrToolNotAvailable",
			err:  ErrToolNotAvailable,
			want: "tool.not_found",
		},
		{
			name: "context.Canceled",
			err:  context.Canceled,
			want: "engine.cancelled",
		},
		{
			name: "context.DeadlineExceeded",
			err:  context.DeadlineExceeded,
			want: "engine.timeout",
		},
		{
			name: "panic in runtime message",
			err:  errors.New("panic in runtime: index out of bounds"),
			want: "engine.panic",
		},
		{
			name: "llm registry message",
			err:  errors.New("llm registry: provider not found"),
			want: "provider.unavailable",
		},
		{
			name: "unknown error",
			err:  errors.New("something unexpected"),
			want: "engine.runtime_error",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := classifyError(tc.err)
			if got != tc.want {
				t.Errorf("classifyError(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}
