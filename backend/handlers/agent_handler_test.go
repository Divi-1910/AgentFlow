package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
	"backend/middleware"
	"backend/repository"
	"backend/tools"
)

// ── shared test constants ─────────────────────────────────────────────────────

const (
	testUserID  = "507f1f77bcf86cd799439011"
	testAgentID = "507f1f77bcf86cd799439012"
)

// ── fakeAgentStore ────────────────────────────────────────────────────────────
//
// Shared by both agent_handler_test.go and thread_handler_test.go (same package).
// All methods are nil-safe: set only the fn fields you need per test.

type fakeAgentStore struct {
	createFn        func(context.Context, string, *agent.Agent) (*agent.Agent, error)
	getByIDFn       func(context.Context, string, string) (*agent.Agent, error)
	getByIDSystemFn func(context.Context, string) (*agent.Agent, error)
	listFn          func(context.Context, string) ([]*agent.Agent, error)
	updateFn        func(context.Context, string, string, repository.UpdateAgentInput) (*agent.Agent, error)
	deleteFn        func(context.Context, string, string) error
}

func (f *fakeAgentStore) Create(ctx context.Context, userID string, a *agent.Agent) (*agent.Agent, error) {
	if f.createFn != nil {
		return f.createFn(ctx, userID, a)
	}
	a.ID = testAgentID
	a.CreatedAt = time.Now()
	return a, nil
}

func (f *fakeAgentStore) GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error) {
	if f.getByIDFn != nil {
		return f.getByIDFn(ctx, agentID, userID)
	}
	return &agent.Agent{ID: agentID, Name: "test-agent"}, nil
}

func (f *fakeAgentStore) GetByIDSystem(ctx context.Context, agentID string) (*agent.Agent, error) {
	if f.getByIDSystemFn != nil {
		return f.getByIDSystemFn(ctx, agentID)
	}
	return &agent.Agent{ID: agentID, Name: "test-agent"}, nil
}

func (f *fakeAgentStore) ListByUser(ctx context.Context, userID string) ([]*agent.Agent, error) {
	if f.listFn != nil {
		return f.listFn(ctx, userID)
	}
	return []*agent.Agent{}, nil
}

func (f *fakeAgentStore) Update(ctx context.Context, agentID, userID string, input repository.UpdateAgentInput) (*agent.Agent, error) {
	if f.updateFn != nil {
		return f.updateFn(ctx, agentID, userID, input)
	}
	return &agent.Agent{ID: agentID, Name: "updated"}, nil
}

func (f *fakeAgentStore) Delete(ctx context.Context, agentID, userID string) error {
	if f.deleteFn != nil {
		return f.deleteFn(ctx, agentID, userID)
	}
	return nil
}

// ── shared helpers ────────────────────────────────────────────────────────────

// withUser injects the shared test user ID into the request context.
func withUser(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), middleware.UserIDKey, testUserID))
}

func newAgentHandler(store *fakeAgentStore) *handlers.AgentHandler {
	reg := tools.NewEmptyRegistry()
	reg.Register(tools.NewCalculatorTool())
	return handlers.NewAgentHandler(store, reg)
}

func decodeJSON(t *testing.T, body []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(body, v); err != nil {
		t.Fatalf("decode JSON: %v\nbody: %s", err, body)
	}
}

// validCreateBody returns a minimal valid CreateAgentRequest JSON body.
func validCreateBody(t *testing.T) *bytes.Buffer {
	t.Helper()
	b, _ := json.Marshal(map[string]any{
		"name":          "my-agent",
		"provider":      "openai",
		"model":         "gpt-4",
		"system_prompt": "you are helpful",
	})
	return bytes.NewBuffer(b)
}

// ── AgentHandler.Create ───────────────────────────────────────────────────────

func TestAgentHandlerCreateRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", validCreateBody(t))
	// deliberately no user in context
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestAgentHandlerCreateRejectsBadJSON(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", bytes.NewBufferString("not json"))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerCreateRejectsMissingRequiredFields(t *testing.T) {
	t.Parallel()
	cases := []map[string]any{
		{"provider": "openai", "model": "gpt-4", "system_prompt": "x"}, // no name
		{"name": "a", "model": "gpt-4", "system_prompt": "x"},          // no provider
		{"name": "a", "provider": "openai", "system_prompt": "x"},      // no model
		{"name": "a", "provider": "openai", "model": "gpt-4"},          // no system_prompt
	}
	for _, body := range cases {
		b, _ := json.Marshal(body)
		h := newAgentHandler(&fakeAgentStore{})
		r := httptest.NewRequest(http.MethodPost, "/api/agents", bytes.NewBuffer(b))
		r = withUser(r)
		w := httptest.NewRecorder()
		h.Create(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %v: got %d, want 400", body, w.Code)
		}
	}
}

func TestAgentHandlerCreateRejectsUnknownTool(t *testing.T) {
	t.Parallel()
	b, _ := json.Marshal(map[string]any{
		"name":          "a",
		"provider":      "openai",
		"model":         "gpt-4",
		"system_prompt": "x",
		"tools":         []string{"ghost_tool"},
	})
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", bytes.NewBuffer(b))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerCreateRejectsDuplicateTool(t *testing.T) {
	t.Parallel()
	b, _ := json.Marshal(map[string]any{
		"name":          "a",
		"provider":      "openai",
		"model":         "gpt-4",
		"system_prompt": "x",
		"tools":         []string{"calculator", "calculator"},
	})
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", bytes.NewBuffer(b))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerCreateReturns201WithDefaults(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", validCreateBody(t))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("got %d, want 201 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["id"] != testAgentID {
		t.Errorf("id: got %v, want %q", resp["id"], testAgentID)
	}
	// defaults must be applied
	if resp["max_steps"] == nil {
		t.Error("max_steps should be set from defaults, got nil")
	}
	if resp["max_tokens"] == nil {
		t.Error("max_tokens should be set from defaults, got nil")
	}
	if resp["max_runs"] != float64(agent.DefaultMaxTaskRuns) {
		t.Errorf("max_runs: got %v, want %d", resp["max_runs"], agent.DefaultMaxTaskRuns)
	}
}

func TestAgentHandlerCreateRejectsInvalidMaxRuns(t *testing.T) {
	t.Parallel()
	b, _ := json.Marshal(map[string]any{
		"name":          "a",
		"provider":      "openai",
		"model":         "gpt-4",
		"system_prompt": "x",
		"max_runs":      0,
	})
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", bytes.NewBuffer(b))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerCreateAcceptsKnownTool(t *testing.T) {
	t.Parallel()
	b, _ := json.Marshal(map[string]any{
		"name":          "a",
		"provider":      "openai",
		"model":         "gpt-4",
		"system_prompt": "x",
		"tools":         []string{"calculator"},
	})
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents", bytes.NewBuffer(b))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusCreated {
		t.Errorf("got %d, want 201 — body: %s", w.Code, w.Body)
	}
}

func TestAgentHandlerCreateForwardsRepoError(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		createFn: func(_ context.Context, _ string, _ *agent.Agent) (*agent.Agent, error) {
			return nil, errors.New("db down")
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodPost, "/api/agents", validCreateBody(t))
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

// ── AgentHandler.List ─────────────────────────────────────────────────────────

func TestAgentHandlerListReturnsAgents(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		listFn: func(_ context.Context, _ string) ([]*agent.Agent, error) {
			return []*agent.Agent{
				{ID: testAgentID, Name: "a1"},
				{ID: "507f1f77bcf86cd799439013", Name: "a2"},
			}, nil
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	var resp []map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp) != 2 {
		t.Errorf("got %d agents, want 2", len(resp))
	}
}

func TestAgentHandlerListReturnsEmptyArray(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{}) // default returns empty slice
	r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
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

func TestAgentHandlerListForwardsRepoError(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		listFn: func(_ context.Context, _ string) ([]*agent.Agent, error) {
			return nil, errors.New("db down")
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

// ── AgentHandler.Get ──────────────────────────────────────────────────────────

func TestAgentHandlerGetReturns200(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/agents/"+testAgentID, nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Get(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
}

func TestAgentHandlerGetReturns404WhenNotFound(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) {
			return nil, errors.New("agent not found")
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodGet, "/api/agents/"+testAgentID, nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Get(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestAgentHandlerGetReturns500OnRepoError(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) {
			return nil, errors.New("connection reset") // not "agent not found"
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodGet, "/api/agents/"+testAgentID, nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Get(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

// ── AgentHandler.Update ───────────────────────────────────────────────────────

func TestAgentHandlerUpdateReturns200WithPatchedName(t *testing.T) {
	t.Parallel()
	const newName = "updated-name"
	store := &fakeAgentStore{
		updateFn: func(_ context.Context, agentID, _ string, input repository.UpdateAgentInput) (*agent.Agent, error) {
			return &agent.Agent{ID: agentID, Name: *input.Name}, nil
		},
	}
	b, _ := json.Marshal(map[string]any{"name": newName})
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodPut, "/api/agents/"+testAgentID, bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["name"] != newName {
		t.Errorf("name: got %v, want %q", resp["name"], newName)
	}
}

func TestAgentHandlerUpdateAcceptsMaxRuns(t *testing.T) {
	t.Parallel()
	const maxRuns = 12
	store := &fakeAgentStore{
		updateFn: func(_ context.Context, agentID, _ string, input repository.UpdateAgentInput) (*agent.Agent, error) {
			if input.MaxRuns == nil || *input.MaxRuns != maxRuns {
				t.Fatalf("MaxRuns input = %v, want %d", input.MaxRuns, maxRuns)
			}
			return &agent.Agent{ID: agentID, Name: "updated", MaxRuns: *input.MaxRuns}, nil
		},
	}
	b, _ := json.Marshal(map[string]any{"max_runs": maxRuns})
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodPut, "/api/agents/"+testAgentID, bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["max_runs"] != float64(maxRuns) {
		t.Errorf("max_runs: got %v, want %d", resp["max_runs"], maxRuns)
	}
}

func TestAgentHandlerUpdateRejectsInvalidMaxRuns(t *testing.T) {
	t.Parallel()
	b, _ := json.Marshal(map[string]any{"max_runs": -1})
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPut, "/api/agents/"+testAgentID, bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerUpdateRejectsBadJSON(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPut, "/api/agents/"+testAgentID, bytes.NewBufferString("{bad json"))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerUpdateRejectsUnknownTool(t *testing.T) {
	t.Parallel()
	b, _ := json.Marshal(map[string]any{"tools": []string{"ghost_tool"}})
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodPut, "/api/agents/"+testAgentID, bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestAgentHandlerUpdateReturns404WhenNotFound(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		updateFn: func(_ context.Context, _, _ string, _ repository.UpdateAgentInput) (*agent.Agent, error) {
			return nil, errors.New("agent not found")
		},
	}
	b, _ := json.Marshal(map[string]any{"name": "x"})
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodPut, "/api/agents/"+testAgentID, bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

// ── AgentHandler.Delete ───────────────────────────────────────────────────────

func TestAgentHandlerDeleteReturns200(t *testing.T) {
	t.Parallel()
	h := newAgentHandler(&fakeAgentStore{})
	r := httptest.NewRequest(http.MethodDelete, "/api/agents/"+testAgentID, nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Delete(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
}

func TestAgentHandlerDeleteReturns404WhenNotFound(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		deleteFn: func(_ context.Context, _, _ string) error {
			return errors.New("agent not found")
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodDelete, "/api/agents/"+testAgentID, nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Delete(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestAgentHandlerDeleteReturns500OnRepoError(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		deleteFn: func(_ context.Context, _, _ string) error {
			return errors.New("connection reset") // not "agent not found"
		},
	}
	h := newAgentHandler(store)
	r := httptest.NewRequest(http.MethodDelete, "/api/agents/"+testAgentID, nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Delete(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}
