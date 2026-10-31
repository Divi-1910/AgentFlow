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
	"backend/pagination"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ── fakeThreadStore ───────────────────────────────────────────────────────────

type fakeThreadStore struct {
	createFn        func(context.Context, string, string, string) (*agent.ThreadRecord, error)
	getByIDFn       func(context.Context, string, string) (*agent.ThreadRecord, error)
	listByAgentFn   func(context.Context, string, string) ([]*agent.ThreadRecord, error)
	updateTitleFn   func(context.Context, string, string, string) error
	updateSummaryFn func(context.Context, string, string, string) error
}

func (f *fakeThreadStore) UpdateTitle(ctx context.Context, threadID, userID, title string) error {
	if f.updateTitleFn != nil {
		return f.updateTitleFn(ctx, threadID, userID, title)
	}
	return nil
}

func (f *fakeThreadStore) Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error) {
	if f.createFn != nil {
		return f.createFn(ctx, userID, agentID, title)
	}
	return fakeThread(title), nil
}

func (f *fakeThreadStore) GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error) {
	if f.getByIDFn != nil {
		return f.getByIDFn(ctx, threadID, userID)
	}
	return fakeThread("thread"), nil
}

func (f *fakeThreadStore) ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error) {
	if f.listByAgentFn != nil {
		return f.listByAgentFn(ctx, agentID, userID)
	}
	return []*agent.ThreadRecord{}, nil
}

func (f *fakeThreadStore) ListByAgentPage(ctx context.Context, agentID, userID string, request pagination.Request) (pagination.Page[*agent.ThreadRecord], error) {
	items, err := f.ListByAgent(ctx, agentID, userID)
	if err != nil {
		return pagination.Page[*agent.ThreadRecord]{}, err
	}
	if len(items) > request.Limit {
		items = items[:request.Limit]
	}
	return pagination.Page[*agent.ThreadRecord]{Items: items}, nil
}

func (f *fakeThreadStore) ListByUserPage(_ context.Context, _ string, _ []string, _ pagination.Request) (pagination.Page[*agent.ThreadRecord], error) {
	return pagination.Page[*agent.ThreadRecord]{Items: []*agent.ThreadRecord{}}, nil
}

func (f *fakeThreadStore) Touch(context.Context, string, string) error { return nil }

func (f *fakeThreadStore) UpdateSummary(ctx context.Context, threadID, userID, summary string) error {
	if f.updateSummaryFn != nil {
		return f.updateSummaryFn(ctx, threadID, userID, summary)
	}
	return nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func fakeThread(title string) *agent.ThreadRecord {
	return &agent.ThreadRecord{
		ID:        bson.NewObjectID().Hex(),
		AgentID:   bson.NewObjectID().Hex(),
		UserID:    bson.NewObjectID().Hex(),
		Title:     title,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

func newThreadHandler(agentStore *fakeAgentStore, threadStore *fakeThreadStore) *handlers.ThreadHandler {
	return handlers.NewThreadHandler(threadStore, agentStore)
}

// ── ThreadHandler.Create ──────────────────────────────────────────────────────

func TestThreadHandlerCreateRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	h := newThreadHandler(&fakeAgentStore{}, &fakeThreadStore{})
	b, _ := json.Marshal(map[string]any{"title": "my thread"})
	r := httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/threads", bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	// no user in context
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestThreadHandlerCreateReturns404WhenAgentNotFound(t *testing.T) {
	t.Parallel()
	agentStore := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) {
			return nil, errors.New("agent not found")
		},
	}
	h := newThreadHandler(agentStore, &fakeThreadStore{})
	b, _ := json.Marshal(map[string]any{"title": "t"})
	r := httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/threads", bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestThreadHandlerCreateForwardsAgentRepoError(t *testing.T) {
	t.Parallel()
	agentStore := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) {
			return nil, errors.New("db timeout") // not "agent not found"
		},
	}
	h := newThreadHandler(agentStore, &fakeThreadStore{})
	b, _ := json.Marshal(map[string]any{"title": "t"})
	r := httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/threads", bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestThreadHandlerCreateReturns201(t *testing.T) {
	t.Parallel()
	const title = "my thread"
	h := newThreadHandler(&fakeAgentStore{}, &fakeThreadStore{})
	b, _ := json.Marshal(map[string]any{"title": title})
	r := httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/threads", bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("got %d, want 201 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["title"] != title {
		t.Errorf("title: got %v, want %q", resp["title"], title)
	}
	if resp["id"] == "" || resp["id"] == nil {
		t.Error("response id must not be empty")
	}
}

func TestThreadHandlerCreateForwardsThreadRepoError(t *testing.T) {
	t.Parallel()
	threadStore := &fakeThreadStore{
		createFn: func(_ context.Context, _, _, _ string) (*agent.ThreadRecord, error) {
			return nil, errors.New("insert failed")
		},
	}
	h := newThreadHandler(&fakeAgentStore{}, threadStore)
	b, _ := json.Marshal(map[string]any{"title": "t"})
	r := httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/threads", bytes.NewBuffer(b))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

// ── ThreadHandler.ListByAgent ─────────────────────────────────────────────────

func TestThreadHandlerListByAgentReturns404WhenAgentNotFound(t *testing.T) {
	t.Parallel()
	agentStore := &fakeAgentStore{
		getByIDFn: func(_ context.Context, _, _ string) (*agent.Agent, error) {
			return nil, errors.New("agent not found")
		},
	}
	h := newThreadHandler(agentStore, &fakeThreadStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/agents/"+testAgentID+"/threads", nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.ListByAgent(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestThreadHandlerListByAgentReturnsThreads(t *testing.T) {
	t.Parallel()
	threadStore := &fakeThreadStore{
		listByAgentFn: func(_ context.Context, _, _ string) ([]*agent.ThreadRecord, error) {
			return []*agent.ThreadRecord{fakeThread("t1"), fakeThread("t2")}, nil
		},
	}
	h := newThreadHandler(&fakeAgentStore{}, threadStore)
	r := httptest.NewRequest(http.MethodGet, "/api/agents/"+testAgentID+"/threads", nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.ListByAgent(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	var resp struct {
		Items []map[string]any `json:"items"`
	}
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp.Items) != 2 {
		t.Errorf("got %d threads, want 2", len(resp.Items))
	}
}

func TestThreadHandlerListByAgentReturnsEmptyArray(t *testing.T) {
	t.Parallel()
	h := newThreadHandler(&fakeAgentStore{}, &fakeThreadStore{}) // default returns []
	r := httptest.NewRequest(http.MethodGet, "/api/agents/"+testAgentID+"/threads", nil)
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.ListByAgent(w, r)
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

func TestThreadHandlerAgentRouteRejectsTeamResource(t *testing.T) {
	t.Parallel()
	agentStore := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		return &agent.Agent{ID: id, Kind: agent.ResourceKindAgentTeam}, nil
	}}
	h := newThreadHandler(agentStore, &fakeThreadStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/threads", bytes.NewBufferString(`{"title":"wrong route"}`))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Create(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", w.Code)
	}
}

func TestThreadHandlerTeamRouteRejectsStandaloneResource(t *testing.T) {
	t.Parallel()
	h := newThreadHandler(&fakeAgentStore{}, &fakeThreadStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agent-teams/"+testAgentID+"/threads", bytes.NewBufferString(`{"title":"wrong route"}`))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.CreateForTeam(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", w.Code)
	}
}

func TestThreadHandlerTeamRouteCreatesTeamThread(t *testing.T) {
	t.Parallel()
	agentStore := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		return &agent.Agent{ID: id, Kind: agent.ResourceKindAgentTeam}, nil
	}}
	h := newThreadHandler(agentStore, &fakeThreadStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/agent-teams/"+testAgentID+"/threads", bytes.NewBufferString(`{"title":"team chat"}`))
	r.SetPathValue("id", testAgentID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.CreateForTeam(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("got %d, want 201 — body: %s", w.Code, w.Body)
	}
	var response handlers.ThreadResponse
	decodeJSON(t, w.Body.Bytes(), &response)
	if response.ResourceKind != agent.ResourceKindAgentTeam {
		t.Fatalf("resource_kind = %q, want %q", response.ResourceKind, agent.ResourceKindAgentTeam)
	}
}

func TestThreadHandlerGetReturnsOwnedThread(t *testing.T) {
	t.Parallel()
	thread := fakeThread("owned")
	thread.AgentID = testAgentID
	store := &fakeThreadStore{getByIDFn: func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
		return thread, nil
	}}
	h := newThreadHandler(&fakeAgentStore{}, store)
	r := httptest.NewRequest(http.MethodGet, "/api/threads/"+thread.ID, nil)
	r.SetPathValue("id", thread.ID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Get(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
}

func TestThreadHandlerUpdateTrimsAndPersistsTitle(t *testing.T) {
	t.Parallel()
	thread := fakeThread("old")
	thread.AgentID = testAgentID
	store := &fakeThreadStore{}
	store.getByIDFn = func(_ context.Context, _, _ string) (*agent.ThreadRecord, error) {
		copy := *thread
		return &copy, nil
	}
	store.updateTitleFn = func(_ context.Context, _, _ string, title string) error {
		thread.Title = title
		thread.UpdatedAt = time.Now()
		return nil
	}
	h := newThreadHandler(&fakeAgentStore{}, store)
	r := httptest.NewRequest(http.MethodPatch, "/api/threads/"+thread.ID, bytes.NewBufferString(`{"title":"  renamed  "}`))
	r.SetPathValue("id", thread.ID)
	r = withUser(r)
	w := httptest.NewRecorder()
	h.Update(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	if thread.Title != "renamed" {
		t.Fatalf("persisted title = %q, want renamed", thread.Title)
	}
}
