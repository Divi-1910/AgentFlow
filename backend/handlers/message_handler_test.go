package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
	"backend/llm"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ── flushableRecorder ─────────────────────────────────────────────────────────
//
// httptest.ResponseRecorder does not implement http.Flusher.
// Send() type-asserts the writer to Flusher; without this it returns 500.

type flushableRecorder struct {
	*httptest.ResponseRecorder
}

func (f *flushableRecorder) Flush() {}

func newFlushable() *flushableRecorder {
	return &flushableRecorder{httptest.NewRecorder()}
}

// ── fakeMessageStore ──────────────────────────────────────────────────────────

type fakeMessageStore struct {
	listRecentFn   func(context.Context, string, int) ([]llm.ChatMessage, error)
	insertManyFn   func(context.Context, string, string, string, []llm.ChatMessage) ([]model.MessageDocument, error)
	listDocsFn     func(context.Context, string, int) ([]model.MessageDocument, error)
}

func (f *fakeMessageStore) ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error) {
	if f.listRecentFn != nil {
		return f.listRecentFn(ctx, threadID, limit)
	}
	return []llm.ChatMessage{}, nil
}

func (f *fakeMessageStore) InsertMany(ctx context.Context, threadID, agentID, userID string, msgs []llm.ChatMessage) ([]model.MessageDocument, error) {
	if f.insertManyFn != nil {
		return f.insertManyFn(ctx, threadID, agentID, userID, msgs)
	}
	return []model.MessageDocument{}, nil
}

func (f *fakeMessageStore) ListDocsByThread(ctx context.Context, threadID string, limit int) ([]model.MessageDocument, error) {
	if f.listDocsFn != nil {
		return f.listDocsFn(ctx, threadID, limit)
	}
	return []model.MessageDocument{}, nil
}

// ── fakeRuntime ───────────────────────────────────────────────────────────────

type fakeRuntime struct {
	runStreamFn func(context.Context, *agent.Agent, agent.RunContext, chan<- agent.StreamEvent) (*agent.RunResult, error)
}

func (f *fakeRuntime) RunStream(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
	if f.runStreamFn != nil {
		return f.runStreamFn(ctx, ag, runCtx, events)
	}
	// Emit terminal event so streamLoop exits cleanly, then close.
	events <- agent.StreamEvent{Type: agent.EventRunCompleted, Time: time.Now()}
	close(events)
	return &agent.RunResult{Output: "ok", Steps: 1}, nil
}

// EstimateSystemPromptTokens returns 0 so the message handler falls back to
// the conservative agent.ShouldSummarize heuristic in tests.
func (f *fakeRuntime) EstimateSystemPromptTokens(_ context.Context, _ *agent.Agent, _ agent.RunContext) int {
	return 0
}

// ── fakeSummarizer ────────────────────────────────────────────────────────────

type fakeSummarizer struct{}

func (f *fakeSummarizer) Summarize(_ context.Context, _ *agent.Agent, _ string, _ []agent.Turn) (string, llm.TokenUsage, error) {
	return "summary", llm.TokenUsage{}, nil
}

// ── fakeRunRepo ───────────────────────────────────────────────────────────────
// Implements agent.CheckpointStore. Most methods are no-ops; only CreateRun is exercised.

type fakeRunRepo struct {
	createRunFn         func(context.Context, string, string, string, string) error
	getRunForUserFn     func(context.Context, string, string) (*agent.RunInfo, error)
	loadLatestFn        func(context.Context, string) (*agent.RunSnapshot, error)
	transitionForUserFn func(context.Context, string, string, string, string) (bool, error)
}

func (f *fakeRunRepo) CreateRun(ctx context.Context, runID, threadID, agentID, userID string) error {
	if f.createRunFn != nil {
		return f.createRunFn(ctx, runID, threadID, agentID, userID)
	}
	return nil
}

func (f *fakeRunRepo) GetRunForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, error) {
	if f.getRunForUserFn != nil {
		return f.getRunForUserFn(ctx, runID, userID)
	}
	return &agent.RunInfo{RunID: runID, Status: "completed"}, nil
}

func (f *fakeRunRepo) Save(_ context.Context, _ agent.RunSnapshot) error              { return nil }
func (f *fakeRunRepo) LoadLatest(ctx context.Context, runID string) (*agent.RunSnapshot, error) {
	if f.loadLatestFn != nil {
		return f.loadLatestFn(ctx, runID)
	}
	return nil, nil // nil snapshot → ValidateSnapshot will fail with 422
}
func (f *fakeRunRepo) TransitionStatus(_ context.Context, _, _, _ string) (bool, error) {
	return true, nil
}
func (f *fakeRunRepo) TransitionStatusForUser(ctx context.Context, runID, userID, from, to string) (bool, error) {
	if f.transitionForUserFn != nil {
		return f.transitionForUserFn(ctx, runID, userID, from, to)
	}
	return true, nil
}
func (f *fakeRunRepo) UpdateStatus(_ context.Context, _, _, _ string) error { return nil }
func (f *fakeRunRepo) IncrementAttempt(_ context.Context, _ string) (int, error) {
	return 1, nil
}
func (f *fakeRunRepo) GetRun(_ context.Context, _ string) (*agent.RunInfo, error) {
	return &agent.RunInfo{}, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

const testThreadID = "507f1f77bcf86cd799439013"

func fakeAgentObj() *agent.Agent {
	return &agent.Agent{
		ID:       testAgentID,
		Provider: "fake",
		Model:    "fake-model",
		MaxSteps: 5,
	}
}

func fakeThreadDoc() *model.ThreadDocument {
	agentOID, _ := bson.ObjectIDFromHex(testAgentID)
	threadOID, _ := bson.ObjectIDFromHex(testThreadID)
	userOID, _ := bson.ObjectIDFromHex(testUserID)
	return &model.ThreadDocument{
		ID:        threadOID,
		AgentID:   agentOID,
		UserID:    userOID,
		Title:     "test thread",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

func newMessageHandler(
	as *fakeAgentStore,
	ts *fakeThreadStore,
	ms *fakeMessageStore,
	rt *fakeRuntime,
	runRepo agent.CheckpointStore,
) *handlers.MessageHandler {
	return handlers.NewMessageHandler(as, ts, ms, rt, &fakeSummarizer{}, runRepo, context.Background())
}

// defaultStores returns stores where all lookups succeed with minimal data.
func defaultStores() (*fakeAgentStore, *fakeThreadStore, *fakeMessageStore) {
	ag := fakeAgentObj()
	thread := fakeThreadDoc()

	as := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) { return ag, nil },
	}
	ts := &fakeThreadStore{
		getByIDFn: func(_ context.Context, _, _ string) (*model.ThreadDocument, error) { return thread, nil },
	}
	ms := &fakeMessageStore{}
	return as, ts, ms
}

// ── MessageHandler.List ───────────────────────────────────────────────────────

func TestMessageHandlerListRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestMessageHandlerListReturns404WhenThreadNotFound(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ts.getByIDFn = func(_ context.Context, _, _ string) (*model.ThreadDocument, error) {
		return nil, errors.New("thread not found")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestMessageHandlerListForwardsThreadRepoError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ts.getByIDFn = func(_ context.Context, _, _ string) (*model.ThreadDocument, error) {
		return nil, errors.New("db timeout") // not "thread not found"
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerListForwardsMessageRepoError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ms.listDocsFn = func(_ context.Context, _ string, _ int) ([]model.MessageDocument, error) {
		return nil, errors.New("db down")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerListReturnsEmptyArray(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("got %d, want 200", w.Code)
	}
	var resp []map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp) != 0 {
		t.Errorf("want empty array, got %d items", len(resp))
	}
}

func TestMessageHandlerListReturnsMessages(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	oid := bson.NewObjectID()
	ms.listDocsFn = func(_ context.Context, _ string, _ int) ([]model.MessageDocument, error) {
		return []model.MessageDocument{
			{ID: oid, Role: "user", Content: "hello", CreatedAt: time.Now()},
			{ID: bson.NewObjectID(), Role: "assistant", Content: "hi", CreatedAt: time.Now()},
		}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	var resp []map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp) != 2 {
		t.Errorf("got %d messages, want 2", len(resp))
	}
	if resp[0]["id"] != oid.Hex() {
		t.Errorf("first message id: got %v, want %q", resp[0]["id"], oid.Hex())
	}
}

func TestMessageHandlerListParseLimitDefault(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	var capturedLimit int
	ms.listDocsFn = func(_ context.Context, _ string, limit int) ([]model.MessageDocument, error) {
		capturedLimit = limit
		return []model.MessageDocument{}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	httptest.NewRecorder() // unused, just structuring
	w := httptest.NewRecorder()
	h.List(w, r)
	if capturedLimit != 50 {
		t.Errorf("default limit: got %d, want 50", capturedLimit)
	}
}

func TestMessageHandlerListParseLimitCustom(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	var capturedLimit int
	ms.listDocsFn = func(_ context.Context, _ string, limit int) ([]model.MessageDocument, error) {
		capturedLimit = limit
		return []model.MessageDocument{}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages?limit=10", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if capturedLimit != 10 {
		t.Errorf("custom limit: got %d, want 10", capturedLimit)
	}
}

func TestMessageHandlerListParseLimitCappedAtMax(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	var capturedLimit int
	ms.listDocsFn = func(_ context.Context, _ string, limit int) ([]model.MessageDocument, error) {
		capturedLimit = limit
		return []model.MessageDocument{}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages?limit=9999", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if capturedLimit != 500 {
		t.Errorf("capped limit: got %d, want 500", capturedLimit)
	}
}

// ── MessageHandler.Send ───────────────────────────────────────────────────────

func validSendBody(t *testing.T) *bytes.Buffer {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"content": "hello agent"})
	return bytes.NewBuffer(b)
}

func TestMessageHandlerSendRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestMessageHandlerSendRejectsBadJSON(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", bytes.NewBufferString("{bad"))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestMessageHandlerSendRejectsEmptyContent(t *testing.T) {
	t.Parallel()
	cases := []string{"", "   ", "\t\n"}
	for _, content := range cases {
		as, ts, ms := defaultStores()
		h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
		b, _ := json.Marshal(map[string]any{"content": content})
		r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", bytes.NewBuffer(b))
		r.SetPathValue("id", testThreadID)
		r = withUser(r)
		w := httptest.NewRecorder()
		h.Send(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("content=%q: got %d, want 400", content, w.Code)
		}
	}
}

func TestMessageHandlerSendReturns404WhenThreadNotFound(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ts.getByIDFn = func(_ context.Context, _, _ string) (*model.ThreadDocument, error) {
		return nil, errors.New("thread not found")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestMessageHandlerSendForwardsThreadRepoError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ts.getByIDFn = func(_ context.Context, _, _ string) (*model.ThreadDocument, error) {
		return nil, errors.New("db timeout")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerSendReturns404WhenAgentNotFound(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	as.getByIDFn = func(_ context.Context, _, _ string) (*agent.Agent, error) {
		return nil, errors.New("agent not found")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestMessageHandlerSendForwardsAgentRepoError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	as.getByIDFn = func(_ context.Context, _, _ string) (*agent.Agent, error) {
		return nil, errors.New("db timeout")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerSendForwardsMessageHistoryError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ms.listRecentFn = func(_ context.Context, _ string, _ int) ([]llm.ChatMessage, error) {
		return nil, errors.New("db down")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerSendReturns500WhenRunCreateFails(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	runRepo := &fakeRunRepo{
		createRunFn: func(_ context.Context, _, _, _, _ string) error {
			return errors.New("mongo write failed")
		},
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, runRepo)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerSendStreamsRunCompletedEvent(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type: got %q, want text/event-stream", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, string(agent.EventRunCompleted)) {
		t.Errorf("response missing EventRunCompleted — body: %s", body)
	}
	if !strings.Contains(body, string(agent.EventRunPersisted)) {
		t.Errorf("response missing EventRunPersisted — body: %s", body)
	}
}

func TestMessageHandlerSendEmitsPersistFailEventOnInsertError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ms.insertManyFn = func(_ context.Context, _, _, _ string, _ []llm.ChatMessage) ([]model.MessageDocument, error) {
		return nil, errors.New("insert failed")
	}
	h := newMessageHandler(as, ts, ms, &fakeRuntime{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)

	body := w.Body.String()
	if !strings.Contains(body, string(agent.EventRunPersistFail)) {
		t.Errorf("response missing EventRunPersistFail — body: %s", body)
	}
}
