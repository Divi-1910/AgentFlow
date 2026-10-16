package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"backend/deployment"
	"backend/handlers"
)

const handlerRuntimeImage = "registry.example/agentflow-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type fakeDeploymentService struct {
	runFn    func(context.Context, deployment.RunRequest) (*deployment.MutationResult, error)
	deleteFn func(context.Context, deployment.DeleteRequest) (*deployment.MutationResult, error)
	getFn    func(context.Context, string, string) (*deployment.DeployState, error)
}

func (f *fakeDeploymentService) RequestRun(ctx context.Context, request deployment.RunRequest) (*deployment.MutationResult, error) {
	return f.runFn(ctx, request)
}

func (f *fakeDeploymentService) RequestDelete(ctx context.Context, request deployment.DeleteRequest) (*deployment.MutationResult, error) {
	return f.deleteFn(ctx, request)
}

func (f *fakeDeploymentService) Get(ctx context.Context, userID, deploymentID string) (*deployment.DeployState, error) {
	return f.getFn(ctx, userID, deploymentID)
}

func newDeploymentHandler(t *testing.T, service *fakeDeploymentService) *handlers.DeploymentHandler {
	t.Helper()
	handler, err := handlers.NewDeploymentHandler(service, "agentflow-runtime", handlerRuntimeImage)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func deploymentState() deployment.DeployState {
	now := time.Date(2026, 10, 15, 1, 2, 3, 4, time.UTC)
	return deployment.DeployState{
		DeploymentID: testAgentID,
		Desired: deployment.DesiredState{
			Generation: 4, Action: deployment.DesiredActionRun,
			Target: deployment.DeploymentTarget{Revision: 3}, RequestedAt: now,
		},
		Observed: deployment.ObservedState{
			Generation: 4, Phase: deployment.DeploymentPhaseReady, Ready: true,
			Endpoint:         "http://must-not-leak.agentflow-runtime.svc.cluster.local",
			LastError:        &deployment.DeploymentError{Code: "old", Message: "stale", Generation: 3},
			LastTransitionAt: now,
		},
		Storage:   deployment.StorageState{Phase: deployment.StoragePhaseReady, PVCUID: "must-not-leak"},
		UpdatedAt: now,
	}
}

func TestDeploymentHandlerDeployUsesPlatformPolicy(t *testing.T) {
	state := deploymentState()
	h := newDeploymentHandler(t, &fakeDeploymentService{runFn: func(_ context.Context, request deployment.RunRequest) (*deployment.MutationResult, error) {
		if request.UserID != testUserID || request.DeploymentID != testAgentID || request.Revision != 3 || request.ExpectedGeneration != 3 {
			t.Fatalf("request = %+v", request)
		}
		if request.Namespace != "agentflow-runtime" || request.RuntimeImage != handlerRuntimeImage {
			t.Fatalf("platform policy = %+v", request)
		}
		return &deployment.MutationResult{State: state, Changed: true}, nil
	}})
	req := withUser(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"revision":3,"expected_generation":3}`)))
	req.SetPathValue("id", testAgentID)
	w := httptest.NewRecorder()
	h.Deploy(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var response handlers.DeploymentStatusResponse
	decodeJSON(t, w.Body.Bytes(), &response)
	if response.Changed == nil || !*response.Changed || response.DesiredGeneration != 4 || response.DesiredAction != "running" ||
		!response.RuntimeAvailable || response.RuntimePath != "/api/agents/"+testAgentID+"/runtime/" || response.LastTransitionAt == "" {
		t.Fatalf("response = %+v", response)
	}
	if strings.Contains(w.Body.String(), "must-not-leak") || strings.Contains(w.Body.String(), ".svc.cluster.local") {
		t.Fatalf("internal infrastructure leaked: %s", w.Body.String())
	}
}

func TestDeploymentHandlerUndeployAndReplayStatuses(t *testing.T) {
	state := deploymentState()
	state.Desired.Action = deployment.DesiredActionDelete
	state.Desired.Generation = 5
	state.Observed.Ready = false
	h := newDeploymentHandler(t, &fakeDeploymentService{deleteFn: func(_ context.Context, request deployment.DeleteRequest) (*deployment.MutationResult, error) {
		if request.UserID != testUserID || request.DeploymentID != testAgentID || request.ExpectedGeneration != 4 {
			t.Fatalf("request = %+v", request)
		}
		return &deployment.MutationResult{State: state, Changed: false}, nil
	}})
	req := withUser(httptest.NewRequest(http.MethodDelete, "/", strings.NewReader(`{"expected_generation":4}`)))
	req.SetPathValue("id", testAgentID)
	w := httptest.NewRecorder()
	h.Undeploy(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var response handlers.DeploymentStatusResponse
	decodeJSON(t, w.Body.Bytes(), &response)
	if response.Changed == nil || *response.Changed || response.DesiredAction != "deleted" || response.RuntimeAvailable || response.RuntimePath != "" {
		t.Fatalf("response = %+v", response)
	}
}

func TestDeploymentHandlerStatusShowsCurrentSafeFailure(t *testing.T) {
	state := deploymentState()
	state.Observed.Ready = false
	state.Observed.Phase = deployment.DeploymentPhaseDegraded
	state.Observed.LastError = &deployment.DeploymentError{
		Code: "kubernetes_unavailable", Message: "runtime infrastructure is temporarily unavailable",
		Retryable: true, Generation: 4, OccurredAt: state.UpdatedAt,
	}
	retryAt := state.UpdatedAt.Add(30 * time.Second)
	state.Reconcile = deployment.ReconcileState{Attempt: 2, DueAt: &retryAt}
	h := newDeploymentHandler(t, &fakeDeploymentService{getFn: func(_ context.Context, userID, deploymentID string) (*deployment.DeployState, error) {
		if userID != testUserID || deploymentID != testAgentID {
			t.Fatalf("scope = %q/%q", userID, deploymentID)
		}
		return &state, nil
	}})
	req := withUser(httptest.NewRequest(http.MethodGet, "/", nil))
	req.SetPathValue("id", testAgentID)
	w := httptest.NewRecorder()
	h.Status(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var response handlers.DeploymentStatusResponse
	decodeJSON(t, w.Body.Bytes(), &response)
	if response.LastError == nil || response.LastError.Code != "kubernetes_unavailable" || !response.LastError.Retryable ||
		response.RuntimeAvailable || response.RuntimePath != "" || response.ReconcileAttempt != 2 || response.RetryScheduledAt == "" {
		t.Fatalf("response = %+v", response)
	}
}

func TestDeploymentHandlerMapsConflictsWithoutLeakingDetails(t *testing.T) {
	tests := []struct {
		err  error
		want int
	}{
		{deployment.ErrRevisionNotFound, http.StatusNotFound},
		{deployment.ErrDeployStateNotFound, http.StatusNotFound},
		{deployment.ErrDeployStateRollback, http.StatusConflict},
		{deployment.ErrDeployStateConflict, http.StatusConflict},
		{deployment.ErrDeployStorageConflict, http.StatusConflict},
		{errors.New("mongo password=secret"), http.StatusInternalServerError},
	}
	for _, tc := range tests {
		h := newDeploymentHandler(t, &fakeDeploymentService{getFn: func(context.Context, string, string) (*deployment.DeployState, error) {
			return nil, tc.err
		}})
		req := withUser(httptest.NewRequest(http.MethodGet, "/", nil))
		req.SetPathValue("id", testAgentID)
		w := httptest.NewRecorder()
		h.Status(w, req)
		if w.Code != tc.want || strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("error=%v status/body=%d/%s", tc.err, w.Code, w.Body.String())
		}
	}
}

func TestDeploymentHandlerRejectsInvalidRequestsBeforeService(t *testing.T) {
	called := false
	service := &fakeDeploymentService{
		runFn: func(context.Context, deployment.RunRequest) (*deployment.MutationResult, error) {
			called = true
			return nil, nil
		},
		deleteFn: func(context.Context, deployment.DeleteRequest) (*deployment.MutationResult, error) {
			called = true
			return nil, nil
		},
	}
	h := newDeploymentHandler(t, service)
	for _, test := range []struct {
		handler http.HandlerFunc
		body    string
	}{
		{h.Deploy, `{"revision":0,"expected_generation":0}`},
		{h.Deploy, `{"revision":1,"expected_generation":-1}`},
		{h.Undeploy, `{"expected_generation":0}`},
	} {
		req := withUser(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body)))
		req.SetPathValue("id", testAgentID)
		w := httptest.NewRecorder()
		test.handler(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d response=%s", test.body, w.Code, w.Body.String())
		}
	}
	if called {
		t.Fatal("service called for invalid request")
	}
}
