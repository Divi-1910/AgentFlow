package handlers_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"backend/deployment"
	"backend/handlers"
)

type fakeRuntimeAccessResolver struct {
	access deployment.RuntimeAccess
	err    error
	state  deployment.DeployState
}

func (f *fakeRuntimeAccessResolver) ResolveAccess(_ context.Context, state deployment.DeployState) (deployment.RuntimeAccess, error) {
	f.state = state
	return f.access, f.err
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestRuntimeProxyScopesAccessAndInjectsServerCredential(t *testing.T) {
	state := deploymentState()
	token, err := deployment.NewRuntimeAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	resolver := &fakeRuntimeAccessResolver{access: deployment.RuntimeAccess{
		BaseURL: "http://runtime.agentflow-runtimes.svc.cluster.local", BearerToken: token,
	}}
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "http://runtime.agentflow-runtimes.svc.cluster.local/v1/chat?stream=true" {
			t.Fatalf("upstream URL = %q", request.URL.String())
		}
		if request.Host != "runtime.agentflow-runtimes.svc.cluster.local" || request.Header.Get("Authorization") != "Bearer "+token {
			t.Fatalf("upstream host/auth = %q/%q", request.Host, request.Header.Get("Authorization"))
		}
		if request.Header.Get("Cookie") != "" || strings.Contains(request.Header.Get("X-Forwarded-For"), "attacker") {
			t.Fatalf("untrusted headers forwarded = %v", request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header: http.Header{
				"Content-Type":     []string{"text/event-stream"},
				"Set-Cookie":       []string{"runtime=must-not-reach-browser"},
				"WWW-Authenticate": []string{`Bearer realm="internal"`},
				"Server":           []string{"internal-runtime"},
			},
			Body:    io.NopCloser(strings.NewReader("data: ready\n\n")),
			Request: request,
		}, nil
	})
	service := &fakeDeploymentService{getFn: func(_ context.Context, userID, deploymentID string) (*deployment.DeployState, error) {
		if userID != testUserID || deploymentID != testAgentID {
			t.Fatalf("scope = %q/%q", userID, deploymentID)
		}
		return &state, nil
	}}
	handler, err := handlers.NewRuntimeProxyHandler(service, resolver, transport)
	if err != nil {
		t.Fatal(err)
	}
	req := withUser(httptest.NewRequest(http.MethodPost, "/api/agents/"+testAgentID+"/runtime/v1/chat?stream=true", strings.NewReader(`{"message":"hello"}`)))
	req.SetPathValue("id", testAgentID)
	req.SetPathValue("path", "v1/chat")
	req.Header.Set("Authorization", "Bearer browser-session-token")
	req.Header.Set("Cookie", "session=browser-session")
	req.Header.Set("X-Forwarded-For", "attacker")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != "data: ready\n\n" {
		t.Fatalf("status/body = %d/%q", w.Code, w.Body.String())
	}
	if w.Header().Get("Set-Cookie") != "" || w.Header().Get("WWW-Authenticate") != "" || w.Header().Get("Server") != "" {
		t.Fatalf("internal response headers leaked = %v", w.Header())
	}
	if resolver.state.UserID != state.UserID || resolver.state.DeploymentID != state.DeploymentID {
		t.Fatalf("resolver state = %+v", resolver.state)
	}
}

func TestRuntimeProxyMapsReadinessAndAccessErrors(t *testing.T) {
	state := deploymentState()
	tests := []struct {
		name       string
		stateErr   error
		resolveErr error
		want       int
	}{
		{name: "missing", stateErr: deployment.ErrDeployStateNotFound, want: http.StatusNotFound},
		{name: "not ready", resolveErr: deployment.ErrRuntimeNotReady, want: http.StatusConflict},
		{name: "access unavailable", resolveErr: deployment.ErrRuntimeAccessUnavailable, want: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeDeploymentService{getFn: func(context.Context, string, string) (*deployment.DeployState, error) {
				if test.stateErr != nil {
					return nil, test.stateErr
				}
				return &state, nil
			}}
			resolver := &fakeRuntimeAccessResolver{err: test.resolveErr}
			handler, err := handlers.NewRuntimeProxyHandler(service, resolver, roundTripFunc(func(*http.Request) (*http.Response, error) {
				t.Fatal("upstream called")
				return nil, nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			req := withUser(httptest.NewRequest(http.MethodGet, "/", nil))
			req.SetPathValue("id", testAgentID)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != test.want {
				t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
