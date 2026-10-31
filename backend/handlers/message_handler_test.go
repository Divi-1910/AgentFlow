package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/dispatcher"
	"backend/handlers"
	"backend/llm"
	"backend/model"
	"backend/pagination"

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

type disconnectedWriter struct {
	header http.Header
}

func (w *disconnectedWriter) Header() http.Header {
	return w.header
}

func (w *disconnectedWriter) Write([]byte) (int, error) {
	return 0, errors.New("client disconnected")
}

func (w *disconnectedWriter) WriteHeader(int) {}
func (w *disconnectedWriter) Flush()          {}

// ── fakeMessageStore ──────────────────────────────────────────────────────────

type fakeMessageStore struct {
	listRecentFn   func(context.Context, string, int) ([]llm.ChatMessage, error)
	insertManyFn   func(context.Context, string, string, string, []llm.ChatMessage) ([]agent.MessageRecord, error)
	listDocsFn     func(context.Context, string, int) ([]agent.MessageRecord, error)
	insertPromptFn func(context.Context, string, string, string, string, string) (agent.MessageRecord, bool, error)
}

func (f *fakeMessageStore) InsertUserPrompt(ctx context.Context, threadID, agentID, userID, runID, content string) (agent.MessageRecord, bool, error) {
	if f.insertPromptFn != nil {
		return f.insertPromptFn(ctx, threadID, agentID, userID, runID, content)
	}
	return agent.MessageRecord{ID: "prompt", ThreadID: threadID, AgentID: agentID, UserID: userID, Role: "user", Content: content, Metadata: map[string]any{"run_id": runID, "attempt": 1}}, true, nil
}

func (f *fakeMessageStore) ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error) {
	if f.listRecentFn != nil {
		return f.listRecentFn(ctx, threadID, limit)
	}
	return []llm.ChatMessage{}, nil
}

func (f *fakeMessageStore) InsertMany(ctx context.Context, threadID, agentID, userID string, msgs []llm.ChatMessage) ([]agent.MessageRecord, error) {
	if f.insertManyFn != nil {
		return f.insertManyFn(ctx, threadID, agentID, userID, msgs)
	}
	return []agent.MessageRecord{}, nil
}

func (f *fakeMessageStore) ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error) {
	if f.listDocsFn != nil {
		return f.listDocsFn(ctx, threadID, limit)
	}
	return []agent.MessageRecord{}, nil
}

func (f *fakeMessageStore) ListDocsByThreadPage(ctx context.Context, threadID string, request pagination.Request) (pagination.Page[agent.MessageRecord], error) {
	items, err := f.ListDocsByThread(ctx, threadID, request.Limit)
	return pagination.Page[agent.MessageRecord]{Items: items}, err
}

// ── fakeDispatcher ────────────────────────────────────────────────────────────

type fakeDispatcher struct {
	dispatchFn func(context.Context, dispatcher.DispatchRequest, chan<- agent.StreamEvent) (*agent.RunResult, error)
	cancelFn   func(string)
}

func (f *fakeDispatcher) CancelRun(runID string) {
	if f.cancelFn != nil {
		f.cancelFn(runID)
	}
}

func (f *fakeDispatcher) Dispatch(ctx context.Context, req dispatcher.DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
	if f.dispatchFn != nil {
		return f.dispatchFn(ctx, req, events)
	}
	events <- agent.StreamEvent{Type: agent.EventRunCompleted, Time: time.Now()}
	close(events)
	return &agent.RunResult{Output: "ok", Steps: 1}, nil
}

func (f *fakeDispatcher) EstimateSystemPromptTokens(_ context.Context, _ dispatcher.EstimateRequest) int {
	return 0
}

// ── fakeRunRepo ───────────────────────────────────────────────────────────────
// Implements agent.CheckpointStore. Most methods are no-ops; only CreateRun is exercised.

type fakeRunRepo struct {
	createRunFn         func(context.Context, string, string, string, string) error
	getRunForUserFn     func(context.Context, string, string) (*agent.RunInfo, error)
	loadLatestFn        func(context.Context, string) (*agent.RunSnapshot, error)
	transitionForUserFn func(context.Context, string, string, string, string) (bool, error)
	listTopLevelFn      func(context.Context, string, string, int) ([]*agent.RunInfo, error)
	admitFn             func(context.Context, agent.RunAdmission) (agent.RunAdmissionResult, error)
	requestCancelFn     func(context.Context, string, string) (*agent.RunInfo, bool, error)
	finalizeCancelFn    func(context.Context, string, string) (bool, error)
	claimDispatchFn     func(context.Context, string) (bool, error)
}

func (f *fakeRunRepo) ListTopLevelPageForUser(ctx context.Context, userID string, filter agent.RunListFilter, request pagination.Request) (pagination.Page[*agent.RunInfo], error) {
	items, err := f.ListTopLevelByThreadForUser(ctx, filter.ThreadID, userID, request.Limit)
	return pagination.Page[*agent.RunInfo]{Items: items}, err
}

func (f *fakeRunRepo) AdmitTopLevelRun(ctx context.Context, in agent.RunAdmission) (agent.RunAdmissionResult, error) {
	if f.admitFn != nil {
		return f.admitFn(ctx, in)
	}
	if f.createRunFn != nil {
		if err := f.createRunFn(ctx, in.RunID, in.ThreadID, in.AgentID, in.UserID); err != nil {
			return agent.RunAdmissionResult{}, err
		}
	}
	return agent.RunAdmissionResult{Run: &agent.RunInfo{RunID: in.RunID, ThreadID: in.ThreadID, AgentID: in.AgentID, UserID: in.UserID, Status: string(model.RunStatusRunning), Attempt: 1, SubmissionKey: in.SubmissionKey, AcceptedInput: in.AcceptedInput}, Created: true}, nil
}

func (f *fakeRunRepo) MarkPromptPersisted(context.Context, string) error { return nil }
func (f *fakeRunRepo) ClaimRunDispatch(ctx context.Context, runID string) (bool, error) {
	if f.claimDispatchFn != nil {
		return f.claimDispatchFn(ctx, runID)
	}
	return true, nil
}

func (f *fakeRunRepo) ResumeTopLevelRunForUser(ctx context.Context, runID, userID string, from []string) (int, bool, error) {
	if f.transitionForUserFn != nil {
		ok, err := f.transitionForUserFn(ctx, runID, userID, from[0], string(model.RunStatusRunning))
		return 2, ok, err
	}
	return 2, true, nil
}

func (f *fakeRunRepo) RequestCancelForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, bool, error) {
	if f.requestCancelFn != nil {
		return f.requestCancelFn(ctx, runID, userID)
	}
	return &agent.RunInfo{RunID: "run-123", AgentID: testAgentID, Status: string(model.RunStatusRunning)}, true, nil
}

func (f *fakeRunRepo) FinalizeCancelForUser(ctx context.Context, runID, userID string) (bool, error) {
	if f.finalizeCancelFn != nil {
		return f.finalizeCancelFn(ctx, runID, userID)
	}
	return true, nil
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

func (f *fakeRunRepo) Save(_ context.Context, _ agent.RunSnapshot) error { return nil }
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
func (f *fakeRunRepo) ListTopLevelByThreadForUser(ctx context.Context, threadID, userID string, limit int) ([]*agent.RunInfo, error) {
	if f.listTopLevelFn != nil {
		return f.listTopLevelFn(ctx, threadID, userID, limit)
	}
	return []*agent.RunInfo{}, nil
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

func fakeThreadDoc() *agent.ThreadRecord {
	return &agent.ThreadRecord{
		ID:        testThreadID,
		AgentID:   testAgentID,
		UserID:    testUserID,
		Title:     "test thread",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

func newMessageHandler(
	as *fakeAgentStore,
	ts *fakeThreadStore,
	ms *fakeMessageStore,
	disp *fakeDispatcher,
	runRepo agent.CheckpointStore,
) *handlers.MessageHandler {
	if runRepo == nil {
		runRepo = &fakeRunRepo{}
	}
	return handlers.NewMessageHandler(as, ts, ms, disp, runRepo)
}

// defaultStores returns stores where all lookups succeed with minimal data.
func defaultStores() (*fakeAgentStore, *fakeThreadStore, *fakeMessageStore) {
	ag := fakeAgentObj()
	thread := fakeThreadDoc()

	as := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) { return ag, nil },
	}
	ts := &fakeThreadStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) { return thread, nil },
	}
	ms := &fakeMessageStore{}
	return as, ts, ms
}

// ── MessageHandler.List ───────────────────────────────────────────────────────

func TestMessageHandlerListRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	ts.getByIDFn = func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
		return nil, errors.New("thread not found")
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	ts.getByIDFn = func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
		return nil, errors.New("db timeout") // not "thread not found"
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	ms.listDocsFn = func(_ context.Context, _ string, _ int) ([]agent.MessageRecord, error) {
		return nil, errors.New("db down")
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("got %d, want 200", w.Code)
	}
	var resp struct {
		Items []map[string]any `json:"items"`
	}
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp.Items) != 0 {
		t.Errorf("want empty items, got %d items", len(resp.Items))
	}
}

func TestMessageHandlerListReturnsMessages(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	oid := bson.NewObjectID()
	ms.listDocsFn = func(_ context.Context, _ string, _ int) ([]agent.MessageRecord, error) {
		return []agent.MessageRecord{
			{ID: oid.Hex(), Role: "user", Content: "hello", Metadata: map[string]any{"run_id": "run-1", "attempt": int64(2)}, CreatedAt: time.Now()},
			{ID: bson.NewObjectID().Hex(), Role: "assistant", Content: "hi", CreatedAt: time.Now()},
		}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	var resp struct {
		Items []map[string]any `json:"items"`
	}
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp.Items) != 2 {
		t.Errorf("got %d messages, want 2", len(resp.Items))
	}
	if resp.Items[0]["id"] != oid.Hex() {
		t.Errorf("first message id: got %v, want %q", resp.Items[0]["id"], oid.Hex())
	}
	if resp.Items[0]["run_id"] != "run-1" || resp.Items[0]["attempt"] != float64(2) {
		t.Errorf("first message run association: got run_id=%v attempt=%v", resp.Items[0]["run_id"], resp.Items[0]["attempt"])
	}
}

func TestMessageHandlerListParseLimitDefault(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	var capturedLimit int
	ms.listDocsFn = func(_ context.Context, _ string, limit int) ([]agent.MessageRecord, error) {
		capturedLimit = limit
		return []agent.MessageRecord{}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	ms.listDocsFn = func(_ context.Context, _ string, limit int) ([]agent.MessageRecord, error) {
		capturedLimit = limit
		return []agent.MessageRecord{}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages?limit=10", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if capturedLimit != 10 {
		t.Errorf("custom limit: got %d, want 10", capturedLimit)
	}
}

func TestMessageHandlerListRejectsLimitAboveMax(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	var capturedLimit int
	ms.listDocsFn = func(_ context.Context, _ string, limit int) ([]agent.MessageRecord, error) {
		capturedLimit = limit
		return []agent.MessageRecord{}, nil
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/messages?limit=9999", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusBadRequest || capturedLimit != 0 {
		t.Errorf("status/limit: got %d/%d, want 400/0", w.Code, capturedLimit)
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
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", bytes.NewBufferString("{bad"))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestMessageHandlerSendRequiresIdempotencyKey(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, &fakeRunRepo{})
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	r.Header.Del("Idempotency-Key")
	w := newFlushable()
	h.Send(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", w.Code)
	}
}

func TestMessageHandlerSendReplaysAcceptedRunWithoutRedispatch(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	dispatched := false
	disp := &fakeDispatcher{dispatchFn: func(context.Context, dispatcher.DispatchRequest, chan<- agent.StreamEvent) (*agent.RunResult, error) {
		dispatched = true
		return nil, nil
	}}
	repo := &fakeRunRepo{
		admitFn: func(_ context.Context, in agent.RunAdmission) (agent.RunAdmissionResult, error) {
			return agent.RunAdmissionResult{Run: &agent.RunInfo{
				RunID: "original-run", ThreadID: in.ThreadID, AgentID: in.AgentID, UserID: in.UserID,
				Status: string(model.RunStatusRunning), AcceptedInput: in.AcceptedInput,
			}, Replayed: true}, nil
		},
		claimDispatchFn: func(context.Context, string) (bool, error) { return false, nil },
	}
	h := newMessageHandler(as, ts, ms, disp, repo)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)
	if dispatched {
		t.Fatal("idempotent replay redispatched the run")
	}
	body := w.Body.String()
	if !strings.Contains(body, `"run_id":"original-run"`) || !strings.Contains(body, `"replayed":true`) {
		t.Fatalf("replay event = %s", body)
	}
}

func TestMessageHandlerSendReturnsActiveRunConflict(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	repo := &fakeRunRepo{admitFn: func(context.Context, agent.RunAdmission) (agent.RunAdmissionResult, error) {
		return agent.RunAdmissionResult{ActiveRun: "active-run"}, agent.ErrThreadRunActive
	}}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, repo)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "active-run") {
		t.Fatalf("got %d body=%s, want 409 with active run", w.Code, w.Body)
	}
}

func TestMessageHandlerSendRejectsEmptyContent(t *testing.T) {
	t.Parallel()
	cases := []string{"", "   ", "\t\n"}
	for _, content := range cases {
		as, ts, ms := defaultStores()
		h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	ts.getByIDFn = func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
		return nil, errors.New("thread not found")
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	ts.getByIDFn = func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
		return nil, errors.New("db timeout")
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Send(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerSendLeavesHistoryLoadingToDispatcher(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ms.listRecentFn = func(_ context.Context, _ string, _ int) ([]llm.ChatMessage, error) {
		return nil, errors.New("db down")
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("got %d, want 200", w.Code)
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
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, runRepo)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMessageHandlerSendStreamsRunCompletedEvent(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
	if !strings.Contains(body, string(agent.EventRunAccepted)) {
		t.Errorf("response missing EventRunAccepted — body: %s", body)
	}
	if !strings.Contains(body, string(agent.EventRunCompleted)) {
		t.Errorf("response missing EventRunCompleted — body: %s", body)
	}
	if !strings.Contains(body, string(agent.EventRunPersisted)) {
		t.Errorf("response missing EventRunPersisted — body: %s", body)
	}
	if strings.Index(body, string(agent.EventRunAccepted)) > strings.Index(body, string(agent.EventRunCompleted)) {
		t.Errorf("EventRunAccepted must precede EventRunCompleted — body: %s", body)
	}
}

func TestMessageHandlerClientDisconnectDoesNotCancelOrSkipPersistence(t *testing.T) {
	as, ts, ms := defaultStores()
	dispatchStarted := make(chan struct{})
	releaseDispatch := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	persisted := make(chan struct{})
	persistErr := make(chan string, 1)
	disp := &fakeDispatcher{dispatchFn: func(ctx context.Context, _ dispatcher.DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
		close(dispatchStarted)
		select {
		case <-ctx.Done():
			cancelled <- struct{}{}
			close(events)
			return nil, ctx.Err()
		case <-releaseDispatch:
			events <- agent.StreamEvent{Type: agent.EventRunCompleted}
			close(events)
			return &agent.RunResult{NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "done"}}}, nil
		}
	}}
	ms.insertManyFn = func(_ context.Context, _, _, _ string, messages []llm.ChatMessage) ([]agent.MessageRecord, error) {
		if len(messages) != 1 || messages[0].Content != "done" {
			persistErr <- fmt.Sprintf("persisted messages = %#v, want completed assistant message", messages)
		}
		close(persisted)
		return []agent.MessageRecord{{Content: "done"}}, nil
	}
	var cancelRequest context.CancelFunc
	repo := &fakeRunRepo{admitFn: func(_ context.Context, admission agent.RunAdmission) (agent.RunAdmissionResult, error) {
		cancelRequest()
		return agent.RunAdmissionResult{Run: &agent.RunInfo{
			RunID: admission.RunID, ThreadID: admission.ThreadID, AgentID: admission.AgentID,
			UserID: admission.UserID, Status: string(model.RunStatusRunning), Attempt: 1,
			AcceptedInput: admission.AcceptedInput,
		}, Created: true}, nil
	}}
	registry := handlers.NewExecutionRegistry()
	h := handlers.NewMessageHandler(as, ts, ms, disp, repo, registry)
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	requestCtx, cancel := context.WithCancel(r.Context())
	cancelRequest = cancel
	r = r.WithContext(requestCtx)
	w := &disconnectedWriter{header: make(http.Header)}
	h.Send(w, r)

	select {
	case <-dispatchStarted:
	case <-time.After(time.Second):
		t.Fatal("runtime-owned dispatch did not start")
	}
	close(releaseDispatch)
	select {
	case <-persisted:
	case <-time.After(time.Second):
		t.Fatal("messages were not persisted after client disconnect")
	}
	select {
	case message := <-persistErr:
		t.Fatal(message)
	default:
	}
	select {
	case <-cancelled:
		t.Fatal("client disconnect cancelled the runtime-owned execution")
	default:
	}
}

func TestMessageHandlerSendPersistsPromptWhenDispatchFailsBeforeResult(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	var saved agent.MessageRecord
	ms.insertPromptFn = func(_ context.Context, threadID, agentID, userID, runID, content string) (agent.MessageRecord, bool, error) {
		saved = agent.MessageRecord{ThreadID: threadID, AgentID: agentID, UserID: userID, Role: "user", Content: content, Metadata: map[string]any{"run_id": runID, "attempt": 1}}
		return saved, true, nil
	}
	disp := &fakeDispatcher{dispatchFn: func(_ context.Context, _ dispatcher.DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
		close(events)
		return nil, errors.New("preparation failed")
	}}
	h := newMessageHandler(as, ts, ms, disp, &fakeRunRepo{})
	r := httptest.NewRequest(http.MethodPost, "/api/threads/"+testThreadID+"/messages", validSendBody(t))
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := newFlushable()
	h.Send(w, r)

	if saved.Role != "user" || saved.Content != "hello agent" {
		t.Fatalf("saved messages = %#v, want the submitted user prompt", saved)
	}
	if metadataStringForTest(saved.Metadata, "run_id") == "" {
		t.Fatalf("saved prompt metadata = %#v, want run_id", saved.Metadata)
	}
	if saved.Metadata["attempt"] != 1 {
		t.Fatalf("saved prompt attempt = %#v, want 1", saved.Metadata["attempt"])
	}
	body := w.Body.String()
	if !strings.Contains(body, string(agent.EventRunPersisted)) || !strings.Contains(body, string(agent.EventRunFailed)) {
		t.Fatalf("response missing persistence or failure event — body: %s", body)
	}
}

func metadataStringForTest(metadata map[string]any, key string) string {
	value, _ := metadata[key].(string)
	return value
}

func TestMessageHandlerSendEmitsPersistFailEventOnInsertError(t *testing.T) {
	t.Parallel()
	as, ts, ms := defaultStores()
	ms.insertManyFn = func(_ context.Context, _, _, _ string, _ []llm.ChatMessage) ([]agent.MessageRecord, error) {
		return nil, errors.New("insert failed")
	}
	h := newMessageHandler(as, ts, ms, &fakeDispatcher{}, nil)
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
