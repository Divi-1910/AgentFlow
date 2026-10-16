package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"backend/deployment"
	"backend/deployment/delivery"
	"backend/handlers"
)

type fakeArtifactService struct {
	authorizeFn func(context.Context, delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error)
}

func (f *fakeArtifactService) Authorize(ctx context.Context, request delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error) {
	return f.authorizeFn(ctx, request)
}

func TestArtifactHandlerReturnsExactAuthorizedBundle(t *testing.T) {
	t.Parallel()
	raw := []byte(`{"schema_version":1,"config_hash":"abc"}`)
	handler := handlers.NewArtifactHandler(&fakeArtifactService{authorizeFn: func(_ context.Context, request delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error) {
		if request.Token != "capability" || request.DeploymentID != "deployment-1" || request.Generation != 4 || request.Revision != 7 {
			t.Fatalf("request = %+v", request)
		}
		return &delivery.AuthorizedBundle{TokenID: "safe-token-id", Revision: deployment.Revision{BundleJSON: raw}}, nil
	}})
	req := artifactRequest("Bearer capability")
	response := httptest.NewRecorder()
	handler.GetBundle(response, req)

	if response.Code != http.StatusOK || response.Body.String() != string(raw) {
		t.Fatalf("status/body = %d/%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/json" ||
		response.Header().Get("Content-Length") != "40" ||
		response.Header().Get("Cache-Control") != "private, no-store" ||
		response.Header().Get("X-Content-Type-Options") != "nosniff" ||
		response.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
		response.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("headers = %v", response.Header())
	}
	if response.Header().Get("Content-Disposition") != "" {
		t.Fatal("internal artifact response should not be marked as a browser download")
	}
}

func TestArtifactHandlerRejectsMalformedAuthorizationBeforeService(t *testing.T) {
	t.Parallel()
	called := false
	handler := handlers.NewArtifactHandler(&fakeArtifactService{authorizeFn: func(context.Context, delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error) {
		called = true
		return nil, nil
	}})
	tests := []struct {
		name    string
		headers []string
	}{
		{name: "missing"},
		{name: "wrong scheme", headers: []string{"Basic capability"}},
		{name: "empty", headers: []string{"Bearer "}},
		{name: "whitespace", headers: []string{"Bearer capability extra"}},
		{name: "duplicate", headers: []string{"Bearer first", "Bearer second"}},
		{name: "oversized", headers: []string{"Bearer " + strings.Repeat("a", 300)}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := artifactRequest("")
			for _, value := range tc.headers {
				req.Header.Add("Authorization", value)
			}
			response := httptest.NewRecorder()
			handler.GetBundle(response, req)
			if response.Code != http.StatusUnauthorized || response.Header().Get("WWW-Authenticate") == "" {
				t.Fatalf("status/headers = %d/%v", response.Code, response.Header())
			}
		})
	}
	if called {
		t.Fatal("service called for malformed Authorization header")
	}
}

func TestArtifactHandlerDoesNotExposeAuthorizationFailureReason(t *testing.T) {
	t.Parallel()
	handler := handlers.NewArtifactHandler(&fakeArtifactService{authorizeFn: func(context.Context, delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error) {
		return nil, delivery.ErrUnauthorized
	}})
	response := httptest.NewRecorder()
	handler.GetBundle(response, artifactRequest("Bearer capability"))
	if response.Code != http.StatusUnauthorized || response.Body.String() != "{\"error\":\"unauthorized\"}\n" {
		t.Fatalf("status/body = %d/%q", response.Code, response.Body.String())
	}
}

func TestArtifactHandlerMapsStorageFailureToInternalError(t *testing.T) {
	t.Parallel()
	handler := handlers.NewArtifactHandler(&fakeArtifactService{authorizeFn: func(context.Context, delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error) {
		return nil, errors.New("database unavailable")
	}})
	response := httptest.NewRecorder()
	handler.GetBundle(response, artifactRequest("Bearer capability"))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database") {
		t.Fatalf("status/body = %d/%q", response.Code, response.Body.String())
	}
}

func TestArtifactHandlerRejectsInvalidPathScope(t *testing.T) {
	t.Parallel()
	handler := handlers.NewArtifactHandler(&fakeArtifactService{authorizeFn: func(context.Context, delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error) {
		t.Fatal("service called")
		return nil, nil
	}})
	request := artifactRequest("Bearer capability")
	request.SetPathValue("generation", "zero")
	response := httptest.NewRecorder()
	handler.GetBundle(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
}

func artifactRequest(authorization string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/deployments/deployment-1/generations/4/revisions/7/bundle", nil)
	request.SetPathValue("deployment", "deployment-1")
	request.SetPathValue("generation", "4")
	request.SetPathValue("revision", "7")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	return request
}
