package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"backend/deployment"
)

type deploymentService interface {
	RequestRun(context.Context, deployment.RunRequest) (*deployment.MutationResult, error)
	RequestDelete(context.Context, deployment.DeleteRequest) (*deployment.MutationResult, error)
	Get(context.Context, string, string) (*deployment.DeployState, error)
}

type DeploymentHandler struct {
	service      deploymentService
	namespace    string
	runtimeImage string
}

func NewDeploymentHandler(service deploymentService, namespace, runtimeImage string) (*DeploymentHandler, error) {
	if service == nil {
		return nil, errors.New("deployment handler: service is required")
	}
	probe := deployment.DeploymentTarget{
		Revision: 1, ConfigHash: strings.Repeat("0", 64), SchemaVersion: 1,
		Namespace: namespace, RuntimeImage: runtimeImage,
	}
	if err := deployment.ValidateDeploymentTarget(probe); err != nil {
		return nil, fmt.Errorf("deployment handler: invalid platform policy: %w", err)
	}
	return &DeploymentHandler{service: service, namespace: namespace, runtimeImage: runtimeImage}, nil
}

type DeployRequest struct {
	Revision           int   `json:"revision"`
	ExpectedGeneration int64 `json:"expected_generation"`
}

type UndeployRequest struct {
	ExpectedGeneration int64 `json:"expected_generation"`
}

type DeploymentErrorResponse struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Retryable  bool   `json:"retryable"`
	Generation int64  `json:"generation"`
	OccurredAt string `json:"occurred_at"`
}

type DeploymentStatusResponse struct {
	DeploymentID       string                     `json:"deployment_id"`
	Changed            *bool                      `json:"changed,omitempty"`
	DesiredGeneration  int64                      `json:"desired_generation"`
	DesiredAction      string                     `json:"desired_action"`
	DesiredRevision    int                        `json:"desired_revision,omitempty"`
	ObservedGeneration int64                      `json:"observed_generation"`
	Phase              deployment.DeploymentPhase `json:"phase"`
	Ready              bool                       `json:"ready"`
	StoragePhase       deployment.StoragePhase    `json:"storage_phase"`
	LastError          *DeploymentErrorResponse   `json:"last_error,omitempty"`
	RuntimeAvailable   bool                       `json:"runtime_available"`
	RuntimePath        string                     `json:"runtime_path,omitempty"`
	ReconcileAttempt   int                        `json:"reconcile_attempt"`
	RetryScheduledAt   string                     `json:"retry_scheduled_at,omitempty"`
	LastTransitionAt   string                     `json:"last_transition_at,omitempty"`
	RequestedAt        string                     `json:"requested_at,omitempty"`
	UpdatedAt          string                     `json:"updated_at,omitempty"`
}

func (h *DeploymentHandler) Deploy(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var request DeployRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if request.Revision <= 0 || request.ExpectedGeneration < 0 {
		writeError(w, http.StatusBadRequest, "revision must be positive and expected_generation must be nonnegative")
		return
	}
	deploymentID := r.PathValue("id")
	result, err := h.service.RequestRun(r.Context(), deployment.RunRequest{
		UserID: userID, DeploymentID: deploymentID, Revision: request.Revision,
		ExpectedGeneration: request.ExpectedGeneration,
		Namespace:          h.namespace, RuntimeImage: h.runtimeImage,
	})
	h.writeMutation(w, deploymentID, result, err)
}

func (h *DeploymentHandler) Undeploy(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var request UndeployRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if request.ExpectedGeneration <= 0 {
		writeError(w, http.StatusBadRequest, "expected_generation must be positive")
		return
	}
	deploymentID := r.PathValue("id")
	result, err := h.service.RequestDelete(r.Context(), deployment.DeleteRequest{
		UserID: userID, DeploymentID: deploymentID, ExpectedGeneration: request.ExpectedGeneration,
	})
	h.writeMutation(w, deploymentID, result, err)
}

func (h *DeploymentHandler) Status(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	deploymentID := r.PathValue("id")
	state, err := h.service.Get(r.Context(), userID, deploymentID)
	if err != nil {
		h.writeServiceError(w, deploymentID, err)
		return
	}
	if state == nil {
		h.writeServiceError(w, deploymentID, deployment.ErrDeployStateNotFound)
		return
	}
	writeJSON(w, http.StatusOK, deploymentStatus(state, nil))
}

func (h *DeploymentHandler) writeMutation(w http.ResponseWriter, deploymentID string, result *deployment.MutationResult, err error) {
	if err != nil {
		h.writeServiceError(w, deploymentID, err)
		return
	}
	if result == nil {
		writeError(w, http.StatusInternalServerError, "deployment operation failed")
		return
	}
	status := http.StatusOK
	if result.Changed {
		status = http.StatusAccepted
	}
	writeJSON(w, status, deploymentStatus(&result.State, &result.Changed))
}

func (h *DeploymentHandler) writeServiceError(w http.ResponseWriter, deploymentID string, err error) {
	switch {
	case errors.Is(err, deployment.ErrRevisionNotFound), errors.Is(err, deployment.ErrDeployStateNotFound):
		writeError(w, http.StatusNotFound, "deployment or publication not found")
	case errors.Is(err, deployment.ErrDeployStateRollback):
		writeError(w, http.StatusConflict, "an older publication must first be restored as a new revision")
	case errors.Is(err, deployment.ErrDeployStateConflict):
		writeError(w, http.StatusConflict, "deployment generation conflict; refresh status and retry")
	case errors.Is(err, deployment.ErrDeployStorageConflict), errors.Is(err, deployment.ErrDeployStateMigrationRequired):
		writeError(w, http.StatusConflict, "deployment storage requires operator attention")
	case errors.Is(err, deployment.ErrDeployStateTarget):
		slog.Error("invalid platform deployment policy", "deployment_id", deploymentID, "error", err)
		writeError(w, http.StatusServiceUnavailable, "managed deployment is not configured correctly")
	default:
		slog.Error("deployment operation failed", "deployment_id", deploymentID, "error", err)
		writeError(w, http.StatusInternalServerError, "deployment operation failed")
	}
}

func deploymentStatus(state *deployment.DeployState, changed *bool) DeploymentStatusResponse {
	response := DeploymentStatusResponse{
		DeploymentID: state.DeploymentID, Changed: changed,
		DesiredGeneration: state.Desired.Generation, DesiredAction: publicDesiredAction(state.Desired.Action),
		DesiredRevision:    state.Desired.Target.Revision,
		ObservedGeneration: state.Observed.Generation, Phase: state.Observed.Phase,
		Ready: state.Observed.Ready, StoragePhase: state.Storage.Phase,
		ReconcileAttempt: state.Reconcile.Attempt,
		LastTransitionAt: formatOptionalTime(state.Observed.LastTransitionAt),
		RequestedAt:      formatOptionalTime(state.Desired.RequestedAt),
		UpdatedAt:        formatOptionalTime(state.UpdatedAt),
	}
	if state.Observed.Ready && state.Observed.Generation == state.Desired.Generation && state.Desired.Action == deployment.DesiredActionRun {
		response.RuntimeAvailable = true
		response.RuntimePath = fmt.Sprintf("/api/agents/%s/runtime/", state.DeploymentID)
	}
	if state.Reconcile.DueAt != nil {
		response.RetryScheduledAt = formatOptionalTime(*state.Reconcile.DueAt)
	}
	if state.Observed.LastError != nil && state.Observed.LastError.Generation == state.Desired.Generation {
		err := state.Observed.LastError
		response.LastError = &DeploymentErrorResponse{
			Code: err.Code, Message: err.Message, Retryable: err.Retryable,
			Generation: err.Generation, OccurredAt: formatOptionalTime(err.OccurredAt),
		}
	}
	return response
}

func publicDesiredAction(action deployment.DesiredAction) string {
	switch action {
	case deployment.DesiredActionRun:
		return "running"
	case deployment.DesiredActionDelete:
		return "deleted"
	default:
		return string(action)
	}
}

func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
