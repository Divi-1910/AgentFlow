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
	"backend/handlers"
	"backend/llm"
	"backend/model"
	"backend/tools"
)

// ── constructor helpers ───────────────────────────────────────────────────────

// newRunHandler wires only runRepo — safe for GetRun tests where nothing else is touched.
func newRunHandler(runRepo agent.CheckpointStore) *handlers.RunHandler {
	return handlers.NewRunHandler(
		&fakeAgentStore{},
		&fakeMessageStore{},
		runRepo,
		&fakeDispatcher{},
		tools.NewEmptyRegistry(),
		agent.ToolCapabilities{AsyncJobs: true},
	)
}

// newResumeRunHandler provides all deps needed for ResumeRun tests.
func newResumeRunHandler(
	repo agent.CheckpointStore,
	as *fakeAgentStore,
	ms *fakeMessageStore,
	rt *fakeDispatcher,
) *handlers.RunHandler {
	return handlers.NewRunHandler(
		as,
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
	if resp["run_id"] != "run-123" {
		t.Errorf("run_id: got %v, want %q", resp["run_id"], "run-123")
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

func TestResumeRunIncrementAttemptFailureIsNonFatal(t *testing.T) {
	t.Parallel()
	// IncrementAttempt fails → handler logs a warning and uses fallback,
	// then continues to stream successfully.
	repo := resumableRepo()
	var incrementCalled bool
	repo2 := &fakeRunRepo{
		getRunForUserFn:     repo.getRunForUserFn,
		loadLatestFn:        repo.loadLatestFn,
		transitionForUserFn: repo.transitionForUserFn,
	}
	_ = repo2
	// Use an inline fakeRunRepo that overrides only IncrementAttempt.
	customRepo := &incrementFailRepo{fakeRunRepo: resumableRepo()}
	h := newResumeRunHandler(customRepo, &fakeAgentStore{}, &fakeMessageStore{}, &fakeDispatcher{})
	r := withUser(resumeRequest(t))
	w := newFlushable()
	h.ResumeRun(w, r)

	_ = incrementCalled
	// Should still stream successfully despite the increment failure.
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	body := w.Body.String()
	if !strings.Contains(body, string(agent.EventRunCompleted)) {
		t.Errorf("response missing EventRunCompleted — body: %s", body)
	}
}

// incrementFailRepo wraps fakeRunRepo and makes IncrementAttempt always fail.
type incrementFailRepo struct {
	*fakeRunRepo
}

func (r *incrementFailRepo) IncrementAttempt(_ context.Context, _ string) (int, error) {
	return 0, errors.New("counter unavailable")
}

// Delegate all other methods to the embedded fakeRunRepo.
func (r *incrementFailRepo) CreateRun(ctx context.Context, a, b, c, d string) error {
	return r.fakeRunRepo.CreateRun(ctx, a, b, c, d)
}
func (r *incrementFailRepo) Save(ctx context.Context, s agent.RunSnapshot) error {
	return r.fakeRunRepo.Save(ctx, s)
}
func (r *incrementFailRepo) LoadLatest(ctx context.Context, id string) (*agent.RunSnapshot, error) {
	return r.fakeRunRepo.LoadLatest(ctx, id)
}
func (r *incrementFailRepo) TransitionStatus(ctx context.Context, a, b, c string) (bool, error) {
	return r.fakeRunRepo.TransitionStatus(ctx, a, b, c)
}
func (r *incrementFailRepo) TransitionStatusForUser(ctx context.Context, a, b, c, d string) (bool, error) {
	return r.fakeRunRepo.TransitionStatusForUser(ctx, a, b, c, d)
}
func (r *incrementFailRepo) UpdateStatus(ctx context.Context, a, b, c string) error {
	return r.fakeRunRepo.UpdateStatus(ctx, a, b, c)
}
func (r *incrementFailRepo) GetRun(ctx context.Context, id string) (*agent.RunInfo, error) {
	return r.fakeRunRepo.GetRun(ctx, id)
}
func (r *incrementFailRepo) GetRunForUser(ctx context.Context, a, b string) (*agent.RunInfo, error) {
	return r.fakeRunRepo.GetRunForUser(ctx, a, b)
}

// suppress unused import
var _ = time.Now
