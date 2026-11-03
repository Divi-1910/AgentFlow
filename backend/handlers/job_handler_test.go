package handlers_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
)

type fakeThreadJobStore struct {
	listFn func(context.Context, string, string, int) ([]agent.JobRecord, error)
}

func (f *fakeThreadJobStore) ListByParentThreadForUser(ctx context.Context, threadID, userID string, limit int) ([]agent.JobRecord, error) {
	if f.listFn != nil {
		return f.listFn(ctx, threadID, userID, limit)
	}
	return []agent.JobRecord{}, nil
}

func TestJobHandlerListByThreadRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	h := handlers.NewJobHandler(&fakeThreadStore{}, &fakeThreadJobStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/threads/thread-1/jobs", nil)
	r.SetPathValue("id", "thread-1")
	w := httptest.NewRecorder()

	h.ListByThread(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestJobHandlerListByThreadHidesUnknownThread(t *testing.T) {
	t.Parallel()
	threads := &fakeThreadStore{getByIDFn: func(context.Context, string, string) (*agent.ThreadRecord, error) {
		return nil, errors.New("thread not found")
	}}
	h := handlers.NewJobHandler(threads, &fakeThreadJobStore{})
	r := withUser(httptest.NewRequest(http.MethodGet, "/api/threads/thread-1/jobs", nil))
	r.SetPathValue("id", "thread-1")
	w := httptest.NewRecorder()

	h.ListByThread(w, r)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestJobHandlerListByThreadReturnsOwnedDurableStatus(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.November, 3, 10, 0, 0, 0, time.UTC)
	var gotThreadID, gotUserID string
	jobs := &fakeThreadJobStore{listFn: func(_ context.Context, threadID, userID string, limit int) ([]agent.JobRecord, error) {
		gotThreadID, gotUserID = threadID, userID
		if limit != 25 {
			t.Fatalf("limit = %d, want 25", limit)
		}
		return []agent.JobRecord{{
			JobID: "job-1", ParentRunID: "run-1", DelegateTool: "delegate_to_researcher",
			TargetAgentID: "researcher", Task: "Research Mumbai weather", Mode: agent.JobModeBackground,
			Status: string(agent.JobStatusSucceeded), Output: "private raw delegated output",
			CallbackStatus: string(agent.CallbackStatusCompleted), CallbackRunID: "callback-1",
			CreatedAt: now, UpdatedAt: now,
		}}, nil
	}}
	h := handlers.NewJobHandler(&fakeThreadStore{}, jobs)
	r := withUser(httptest.NewRequest(http.MethodGet, "/api/threads/thread-1/jobs?limit=25", nil))
	r.SetPathValue("id", "thread-1")
	w := httptest.NewRecorder()

	h.ListByThread(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if gotThreadID != "thread-1" || gotUserID == "" {
		t.Fatalf("owned query = thread %q user %q", gotThreadID, gotUserID)
	}
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Items) != 1 || body.Items[0]["id"] != "job-1" || body.Items[0]["callback_status"] != "completed" {
		t.Fatalf("items = %#v", body.Items)
	}
	if _, exposed := body.Items[0]["output"]; exposed {
		t.Fatalf("raw delegated output must not be exposed: %#v", body.Items[0])
	}
}
