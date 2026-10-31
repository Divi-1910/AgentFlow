package handlers_test

import (
	"context"
	"errors"
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
	"backend/tools"
)

// ── constructor helpers ───────────────────────────────────────────────────────

type handlerRunStore interface {
	agent.CheckpointStore
	ListTopLevelByThreadForUser(context.Context, string, string, int) ([]*agent.RunInfo, error)
	ResumeTopLevelRunForUser(context.Context, string, string, []string) (int, bool, error)
	RequestCancelForUser(context.Context, string, string) (*agent.RunInfo, bool, error)
	FinalizeCancelForUser(context.Context, string, string) (bool, error)
}

// newRunHandler wires only runRepo — safe for GetRun tests where nothing else is touched.
func newRunHandler(runRepo handlerRunStore) *handlers.RunHandler {
	return handlers.NewRunHandler(
		&fakeAgentStore{},
		&fakeThreadStore{},
		&fakeMessageStore{},
		runRepo,
		&fakeDispatcher{},
		tools.NewEmptyRegistry(),
		agent.ToolCapabilities{AsyncJobs: true},
	)
}

// newResumeRunHandler provides all deps needed for ResumeRun tests.
func newResumeRunHandler(
	repo handlerRunStore,
	as *fakeAgentStore,
	ms *fakeMessageStore,
	rt *fakeDispatcher,
) *handlers.RunHandler {
	return handlers.NewRunHandler(
		as,
		&fakeThreadStore{},
		ms,
		repo,
		rt,
		tools.NewEmptyRegistry(),
		agent.ToolCapabilities{AsyncJobs: true},
	)
}

// validSnapshot returns a snapshot that passes ValidateSnapshot with an empty tool registry.
func validSnapshot() *agent.RunSnapshot {
	return &agent.RunSnapshot{
		Version: 1,
		RunID:   "run-123",
		State: agent.RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "hello"}},
			StepsCompleted: 1,
			MaxSteps:       10,
			ToolFailures:   map[string]int{},
		},
		Meta: agent.SnapshotMeta{
			AgentID:  testAgentID,
			ThreadID: testThreadID,
			Attempt:  1,
		},
	}
}

// resumableRepo returns a fakeRunRepo where the run is resumable and
// all state transitions succeed — a baseline to override per-test.
func resumableRepo() *fakeRunRepo {
	return &fakeRunRepo{
		getRunForUserFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, error) {
			return &agent.RunInfo{RunID: runID, Status: string(model.RunStatusResumable)}, nil
		},
		loadLatestFn: func(_ context.Context, _ string) (*agent.RunSnapshot, error) {
			return validSnapshot(), nil
		},
	}
}

// ── RunHandler.GetRun ─────────────────────────────────────────────────────────

func TestRunHandlerGetRunRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	h := newRunHandler(&fakeRunRepo{})
	r := httptest.NewRequest(http.MethodGet, "/api/runs/run-123", nil)
	r.SetPathValue("id", "run-123")
	w := httptest.NewRecorder()
	h.GetRun(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestRunHandlerGetRunReturns400ForEmptyRunID(t *testing.T) {
	t.Parallel()
	h := newRunHandler(&fakeRunRepo{})
	r := httptest.NewRequest(http.MethodGet, "/api/runs/", nil)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.GetRun(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestRunHandlerGetRunReturns404WhenRunNotFound(t *testing.T) {
	t.Parallel()
	repo := &fakeRunRepo{
		getRunForUserFn: func(_ context.Context, _, _ string) (*agent.RunInfo, error) {
			return nil, errors.New("run not found")
		},
	}
	h := newRunHandler(repo)
	r := httptest.NewRequest(http.MethodGet, "/api/runs/run-123", nil)
	r.SetPathValue("id", "run-123")
	r = withUser(r)
	w := httptest.NewRecorder()
	h.GetRun(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestRunHandlerGetRunReturns200WithRunInfo(t *testing.T) {
	t.Parallel()
	h := newRunHandler(&fakeRunRepo{})
	r := httptest.NewRequest(http.MethodGet, "/api/runs/run-123", nil)
	r.SetPathValue("id", "run-123")
	r = withUser(r)
	w := httptest.NewRecorder()
	h.GetRun(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["id"] != "run-123" {
		t.Errorf("id: got %v, want %q", resp["id"], "run-123")
	}
	if _, exposed := resp["user_id"]; exposed {
		t.Error("product run response must not expose user_id")
	}
}

func TestRunHandlerStreamEventsReplaysAfterLastEventID(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	published := make(chan struct{})
	started, err := registry.Start("run-events", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunStarted})
		publish(agent.StreamEvent{Type: agent.EventRunCompleted})
		close(published)
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	<-published
	repo := &fakeRunRepo{getRunForUserFn: func(_ context.Context, runID, userID string) (*agent.RunInfo, error) {
		if userID != testUserID {
			t.Fatalf("user id = %q, want %q", userID, testUserID)
		}
		return &agent.RunInfo{RunID: runID, InvocationKind: agent.InvocationTopLevel}, nil
	}}
	h := handlers.NewRunHandler(
		&fakeAgentStore{}, &fakeThreadStore{}, &fakeMessageStore{}, repo,
		&fakeDispatcher{}, tools.NewEmptyRegistry(), agent.ToolCapabilities{AsyncJobs: true}, registry,
	)
	r := httptest.NewRequest(http.MethodGet, "/api/runs/run-events/events", nil)
	r.SetPathValue("id", "run-events")
	r.Header.Set("Last-Event-ID", "run-events:1")
	r = withUser(r)
	w := newFlushable()
	h.StreamEvents(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	body := w.Body.String()
	if !strings.Contains(body, "id: run-events:2") || !strings.Contains(body, "event: run.completed") {
		t.Fatalf("SSE body = %q, want replayed terminal event with standard id/event fields", body)
	}
	if strings.Contains(body, "event: run.started") {
		t.Fatalf("SSE body replayed an event at or before Last-Event-ID: %q", body)
	}
	if !strings.Contains(body, `"delivery_replayed":true`) {
		t.Fatalf("SSE body = %q, want delivery replay marker", body)
	}
}

func TestRunHandlerStreamEventsReturnsGoneWhenBufferExpired(t *testing.T) {
	repo := &fakeRunRepo{getRunForUserFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, error) {
		return &agent.RunInfo{RunID: runID, InvocationKind: agent.InvocationTopLevel}, nil
	}}
	h := handlers.NewRunHandler(
		&fakeAgentStore{}, &fakeThreadStore{}, &fakeMessageStore{}, repo,
		&fakeDispatcher{}, tools.NewEmptyRegistry(), agent.ToolCapabilities{AsyncJobs: true},
		handlers.NewExecutionRegistry(),
	)
	r := httptest.NewRequest(http.MethodGet, "/api/runs/run-expired/events", nil)
	r.SetPathValue("id", "run-expired")
	r = withUser(r)
	w := newFlushable()
	h.StreamEvents(w, r)
	if w.Code != http.StatusGone {
		t.Fatalf("got %d, want 410 — body: %s", w.Code, w.Body)
	}
}

func TestRunHandlerStreamEventsHidesChildRuns(t *testing.T) {
	repo := &fakeRunRepo{getRunForUserFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, error) {
		return &agent.RunInfo{RunID: runID, ParentRunID: "parent-run"}, nil
	}}
	h := newRunHandler(repo)
	r := httptest.NewRequest(http.MethodGet, "/api/runs/child-run/events", nil)
	r.SetPathValue("id", "child-run")
	r = withUser(r)
	w := newFlushable()
	h.StreamEvents(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 — body: %s", w.Code, w.Body)
	}
}

func TestRunHandlerListByThreadReturnsProductRuns(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	repo := &fakeRunRepo{listTopLevelFn: func(_ context.Context, threadID, userID string, limit int) ([]*agent.RunInfo, error) {
		if threadID != testThreadID || userID != testUserID || limit != 25 {
			t.Fatalf("list args = (%q, %q, %d)", threadID, userID, limit)
		}
		return []*agent.RunInfo{{
			RunID: "run-1", ThreadID: threadID, AgentID: testAgentID,
			Status: string(model.RunStatusInterrupted), Attempt: 2,
			CreatedAt: now, UpdatedAt: now,
		}}, nil
	}}
	h := handlers.NewRunHandler(
		&fakeAgentStore{},
		&fakeThreadStore{getByIDFn: func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
			return &agent.ThreadRecord{ID: testThreadID, AgentID: testAgentID}, nil
		}},
		&fakeMessageStore{}, repo, &fakeDispatcher{}, tools.NewEmptyRegistry(),
		agent.ToolCapabilities{AsyncJobs: true},
	)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+testThreadID+"/runs?limit=25", nil)
	r.SetPathValue("id", testThreadID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.ListByThread(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var response struct {
		Items []map[string]any `json:"items"`
	}
	decodeJSON(t, w.Body.Bytes(), &response)
	if len(response.Items) != 1 || response.Items[0]["id"] != "run-1" || response.Items[0]["resumable"] != true {
		t.Fatalf("response = %#v", response)
	}
	if _, exposed := response.Items[0]["originator_run_id"]; exposed {
		t.Error("product run response must not expose delegation lineage")
	}
}

func TestRunHandlerCancelAbandonsInterruptedRun(t *testing.T) {
	t.Parallel()
	status := string(model.RunStatusInterrupted)
	repo := &fakeRunRepo{
		requestCancelFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, bool, error) {
			status = string(model.RunStatusCancelling)
			return &agent.RunInfo{RunID: runID, AgentID: testAgentID, Status: string(model.RunStatusInterrupted)}, true, nil
		},
		finalizeCancelFn: func(context.Context, string, string) (bool, error) {
			status = string(model.RunStatusCancelled)
			return true, nil
		},
		getRunForUserFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, error) {
			return &agent.RunInfo{RunID: runID, AgentID: testAgentID, Status: status, CreatedAt: time.Now(), UpdatedAt: time.Now()}, nil
		},
	}
	h := newRunHandler(repo)
	r := httptest.NewRequest(http.MethodPost, "/api/runs/run-123/cancel", nil)
	r.SetPathValue("id", "run-123")
	r = withUser(r)
	w := httptest.NewRecorder()
	h.CancelRun(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("got %d body=%s", w.Code, w.Body)
	}
}

func TestRunHandlerCancelRejectsCompletedRun(t *testing.T) {
	t.Parallel()
	repo := &fakeRunRepo{requestCancelFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, bool, error) {
		return &agent.RunInfo{RunID: runID, Status: string(model.RunStatusCompleted)}, false, nil
	}}
	h := newRunHandler(repo)
	r := httptest.NewRequest(http.MethodPost, "/api/runs/run-123/cancel", nil)
	r.SetPathValue("id", "run-123")
	r = withUser(r)
	w := httptest.NewRecorder()
	h.CancelRun(w, r)
	if w.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409", w.Code)
	}
}

func TestRunHandlerCancelFinalizesAcceptedUndispatchedRun(t *testing.T) {
	t.Parallel()
	status := string(model.RunStatusRunning)
	repo := &fakeRunRepo{
		requestCancelFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, bool, error) {
			status = string(model.RunStatusCancelling)
			return &agent.RunInfo{
				RunID: runID, AgentID: testAgentID, Status: string(model.RunStatusRunning),
				DispatchStarted: false,
			}, true, nil
		},
		finalizeCancelFn: func(context.Context, string, string) (bool, error) {
			status = string(model.RunStatusCancelled)
			return true, nil
		},
		getRunForUserFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, error) {
			return &agent.RunInfo{RunID: runID, AgentID: testAgentID, Status: status}, nil
		},
	}
	h := newRunHandler(repo)
	r := httptest.NewRequest(http.MethodPost, "/api/runs/run-123/cancel", nil)
	r.SetPathValue("id", "run-123")
	r = withUser(r)
	w := httptest.NewRecorder()
	h.CancelRun(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("got %d body=%s", w.Code, w.Body)
	}
}

// ── RunHandler.ResumeRun ──────────────────────────────────────────────────────

func resumeRequest(t *testing.T) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/runs/run-123/resume", nil)
	r.SetPathValue("id", "run-123")
	return r
}

func TestResumeRunRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	h := newResumeRunHandler(resumableRepo(), &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := resumeRequest(t) // no user in context
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestResumeRunReturns400ForEmptyRunID(t *testing.T) {
	t.Parallel()
	h := newResumeRunHandler(resumableRepo(), &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := httptest.NewRequest(http.MethodPost, "/api/runs//resume", nil)
	// no SetPathValue → PathValue("id") == ""
	r = withUser(r)
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestResumeRunReturns404WhenRunNotFound(t *testing.T) {
	t.Parallel()
	repo := &fakeRunRepo{
		getRunForUserFn: func(_ context.Context, _, _ string) (*agent.RunInfo, error) {
			return nil, errors.New("not found")
		},
	}
	h := newResumeRunHandler(repo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestResumeRunReturns409WhenRunNotResumable(t *testing.T) {
	t.Parallel()
	repo := &fakeRunRepo{
		getRunForUserFn: func(_ context.Context, runID, _ string) (*agent.RunInfo, error) {
			// "completed" is not a resumable status
			return &agent.RunInfo{RunID: runID, Status: string(model.RunStatusCompleted)}, nil
		},
	}
	h := newResumeRunHandler(repo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("got %d, want 409", w.Code)
	}
}

func TestResumeRunReturns500WhenTransitionFails(t *testing.T) {
	t.Parallel()
	repo := resumableRepo()
	repo.transitionForUserFn = func(_ context.Context, _, _, _, _ string) (bool, error) {
		return false, errors.New("db write failed")
	}
	h := newResumeRunHandler(repo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestResumeRunReturns409WhenClaimFails(t *testing.T) {
	t.Parallel()
	repo := resumableRepo()
	repo.transitionForUserFn = func(_ context.Context, _, _, _, _ string) (bool, error) {
		return false, nil // claimed=false, no error → concurrent resume
	}
	h := newResumeRunHandler(repo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("got %d, want 409", w.Code)
	}
}

func TestResumeRunReturns500WhenLoadLatestFails(t *testing.T) {
	t.Parallel()
	repo := resumableRepo()
	repo.loadLatestFn = func(_ context.Context, _ string) (*agent.RunSnapshot, error) {
		return nil, errors.New("storage unavailable")
	}
	h := newResumeRunHandler(repo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestResumeRunReturns422WhenSnapshotInvalid(t *testing.T) {
	t.Parallel()
	repo := resumableRepo()
	repo.loadLatestFn = func(_ context.Context, _ string) (*agent.RunSnapshot, error) {
		return nil, nil // nil snapshot → ValidateSnapshot returns error
	}
	h := newResumeRunHandler(repo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Errorf("got %d, want 422", w.Code)
	}
}

func TestResumeRunReturns500WhenAgentNotFound(t *testing.T) {
	t.Parallel()
	as := &fakeAgentStore{
		getByIDSystemFn: func(_ context.Context, _ string) (*agent.Agent, error) {
			return nil, errors.New("agent not found")
		},
	}
	h := newResumeRunHandler(resumableRepo(), as, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := httptest.NewRecorder()
	h.ResumeRun(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestResumeRunStreamsRunCompletedEvent(t *testing.T) {
	t.Parallel()
	h := newResumeRunHandler(resumableRepo(), &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := newFlushable()
	h.ResumeRun(w, r)

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

func TestResumeRunUsesAttemptFromAtomicClaim(t *testing.T) {
	t.Parallel()
	var attempt int
	dispatcher := &fakeDispatcher{dispatchFn: func(_ context.Context, req dispatcher.DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
		attempt = req.Attempt
		events <- agent.StreamEvent{Type: agent.EventRunCompleted}
		close(events)
		return &agent.RunResult{Output: "ok"}, nil
	}}
	h := newResumeRunHandler(resumableRepo(), &fakeAgentStore{}, &fakeMessageStore{}, dispatcher)
	r := withUser(resumeRequest(t))
	w := newFlushable()
	h.ResumeRun(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	if attempt != 2 {
		t.Fatalf("dispatch attempt = %d, want 2", attempt)
	}
}

// suppress unused import
var _ = time.Now
