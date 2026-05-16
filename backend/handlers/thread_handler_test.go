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
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ── fakeThreadStore ───────────────────────────────────────────────────────────

type fakeThreadStore struct {
	createFn        func(context.Context, string, string, string) (*model.ThreadDocument, error)
	getByIDFn       func(context.Context, string, string) (*model.ThreadDocument, error)
	listByAgentFn   func(context.Context, string, string) ([]*model.ThreadDocument, error)
	updateSummaryFn func(context.Context, string, string, string) error
}

func (f *fakeThreadStore) Create(ctx context.Context, userID, agentID, title string) (*model.ThreadDocument, error) {
	if f.createFn != nil {
		return f.createFn(ctx, userID, agentID, title)
	}
	return fakeThread(title), nil
}

func (f *fakeThreadStore) GetByID(ctx context.Context, threadID, userID string) (*model.ThreadDocument, error) {
	if f.getByIDFn != nil {
		return f.getByIDFn(ctx, threadID, userID)
	}
	return fakeThread("thread"), nil
}

func (f *fakeThreadStore) ListByAgent(ctx context.Context, agentID, userID string) ([]*model.ThreadDocument, error) {
	if f.listByAgentFn != nil {
		return f.listByAgentFn(ctx, agentID, userID)
	}
	return []*model.ThreadDocument{}, nil
}

func (f *fakeThreadStore) UpdateSummary(ctx context.Context, threadID, userID, summary string) error {
	if f.updateSummaryFn != nil {
		return f.updateSummaryFn(ctx, threadID, userID, summary)
	}
	return nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func fakeThread(title string) *model.ThreadDocument {
	return &model.ThreadDocument{
		ID:        bson.NewObjectID(),
		AgentID:   bson.NewObjectID(),
		UserID:    bson.NewObjectID(),
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
		createFn: func(_ context.Context, _, _, _ string) (*model.ThreadDocument, error) {
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
		listByAgentFn: func(_ context.Context, _, _ string) ([]*model.ThreadDocument, error) {
			return []*model.ThreadDocument{fakeThread("t1"), fakeThread("t2")}, nil
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
	var resp []map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp) != 2 {
		t.Errorf("got %d threads, want 2", len(resp))
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
	var resp []map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp) != 0 {
		t.Errorf("want empty array, got %d items", len(resp))
	}
}
