package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"backend/deployment"
	"backend/handlers"
	"backend/publisher"
)

type fakePublicationService struct {
	publishFn func(context.Context, string, string) (*publisher.Result, error)
	getFn     func(context.Context, string, string, int) (*deployment.Revision, error)
}

func (f *fakePublicationService) Publish(ctx context.Context, userID, agentID string) (*publisher.Result, error) {
	return f.publishFn(ctx, userID, agentID)
}

func (f *fakePublicationService) GetBundle(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error) {
	return f.getFn(ctx, userID, deploymentID, revision)
}

func TestPublicationHandlerPublishStatusesAndResponse(t *testing.T) {
	createdAt := time.Date(2026, 7, 12, 1, 2, 3, 4, time.UTC)
	for _, tc := range []struct {
		name        string
		wasExisting bool
		wantStatus  int
	}{
		{name: "new", wantStatus: http.StatusCreated},
		{name: "existing", wasExisting: true, wantStatus: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakePublicationService{publishFn: func(_ context.Context, userID, agentID string) (*publisher.Result, error) {
				if userID != testUserID || agentID != testAgentID {
					t.Fatalf("scope = %q/%q", userID, agentID)
				}
				return &publisher.Result{Revision: &deployment.Revision{
					DeploymentID: testAgentID, Revision: 3, ConfigHash: "abc", CreatedAt: createdAt,
				}, WasExisting: tc.wasExisting}, nil
			}}
			h := handlers.NewPublicationHandler(svc)
			req := withUser(httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/publish", nil))
			req.SetPathValue("id", testAgentID)
			w := httptest.NewRecorder()
			h.Publish(w, req)
			if w.Code != tc.wantStatus {
				t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
			}
			wantURL := "/api/agents/" + testAgentID + "/publications/3/bundle"
			if w.Header().Get("Location") != wantURL {
				t.Fatalf("Location = %q", w.Header().Get("Location"))
			}
			var response handlers.PublishAgentResponse
			decodeJSON(t, w.Body.Bytes(), &response)
			if response.DeploymentID != testAgentID || response.Revision != 3 || response.WasExisting != tc.wasExisting || response.BundleURL != wantURL || response.CreatedAt != createdAt.Format(time.RFC3339Nano) {
				t.Fatalf("response = %+v", response)
			}
		})
	}
}

func TestPublicationHandlerPublishErrorMapping(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "not found", err: publisher.ErrRootAgentNotFound, want: 404},
		{name: "unstable", err: publisher.ErrGraphUnstable, want: 409},
		{name: "graph", err: publisher.ErrInvalidGraph, want: 422},
		{name: "bundle", err: publisher.ErrInvalidBundle, want: 422},
		{name: "large", err: publisher.ErrBundleTooLarge, want: 422},
		{name: "internal", err: errors.New("database unavailable"), want: 500},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := handlers.NewPublicationHandler(&fakePublicationService{publishFn: func(context.Context, string, string) (*publisher.Result, error) {
				return nil, tc.err
			}})
			req := withUser(httptest.NewRequest(http.MethodPost, "/", nil))
			req.SetPathValue("id", testAgentID)
			w := httptest.NewRecorder()
			h.Publish(w, req)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}

func TestPublicationHandlerRequiresAuthentication(t *testing.T) {
	svc := &fakePublicationService{
		publishFn: func(context.Context, string, string) (*publisher.Result, error) { t.Fatal("called"); return nil, nil },
		getFn: func(context.Context, string, string, int) (*deployment.Revision, error) {
			t.Fatal("called")
			return nil, nil
		},
	}
	h := handlers.NewPublicationHandler(svc)
	for _, handler := range []http.HandlerFunc{h.Publish, h.GetBundle} {
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequest(http.MethodGet, "/", nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", w.Code)
		}
	}
}

func TestPublicationHandlerGetBundleReturnsExactBytes(t *testing.T) {
	raw := []byte(`{"schema_version":1}`)
	svc := &fakePublicationService{getFn: func(_ context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error) {
		if userID != testUserID || deploymentID != testAgentID || revision != 2 {
			t.Fatalf("scope = %q/%q/%d", userID, deploymentID, revision)
		}
		return &deployment.Revision{BundleJSON: raw}, nil
	}}
	h := handlers.NewPublicationHandler(svc)
	req := withUser(httptest.NewRequest(http.MethodGet, "/", nil))
	req.SetPathValue("id", testAgentID)
	req.SetPathValue("revision", "2")
	w := httptest.NewRecorder()
	h.GetBundle(w, req)
	if w.Code != http.StatusOK || w.Body.String() != string(raw) {
		t.Fatalf("status/body = %d/%q", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Content-Disposition") != `attachment; filename="deployment-`+testAgentID+`-r2.json"` {
		t.Fatalf("headers = %v", w.Header())
	}
}

func TestPublicationHandlerGetBundleErrors(t *testing.T) {
	h := handlers.NewPublicationHandler(&fakePublicationService{getFn: func(context.Context, string, string, int) (*deployment.Revision, error) {
		return nil, deployment.ErrRevisionNotFound
	}})
	for _, tc := range []struct {
		revision string
		want     int
	}{{"bad", 400}, {"0", 400}, {"1", 404}} {
		req := withUser(httptest.NewRequest(http.MethodGet, "/", nil))
		req.SetPathValue("id", testAgentID)
		req.SetPathValue("revision", tc.revision)
		w := httptest.NewRecorder()
		h.GetBundle(w, req)
		if w.Code != tc.want {
			t.Fatalf("revision %q status=%d want=%d", tc.revision, w.Code, tc.want)
		}
	}
}
