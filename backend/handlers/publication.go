package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"backend/deployment"
	"backend/publisher"
)

type publicationService interface {
	Publish(ctx context.Context, userID, rootAgentID string) (*publisher.Result, error)
	GetBundle(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error)
}

type PublicationHandler struct{ service publicationService }

func NewPublicationHandler(service publicationService) *PublicationHandler {
	return &PublicationHandler{service: service}
}

type PublishAgentResponse struct {
	DeploymentID string `json:"deployment_id"`
	Revision     int    `json:"revision"`
	ConfigHash   string `json:"config_hash"`
	WasExisting  bool   `json:"was_existing"`
	CreatedAt    string `json:"created_at"`
	BundleURL    string `json:"bundle_url"`
}

func (h *PublicationHandler) Publish(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	agentID := r.PathValue("id")
	result, err := h.service.Publish(r.Context(), userID, agentID)
	if err != nil {
		switch {
		case errors.Is(err, publisher.ErrRootAgentNotFound):
			writeError(w, http.StatusNotFound, "agent not found")
		case errors.Is(err, publisher.ErrGraphUnstable):
			writeError(w, http.StatusConflict, "agent graph changed during publication; retry")
		case errors.Is(err, publisher.ErrInvalidGraph), errors.Is(err, publisher.ErrInvalidBundle), errors.Is(err, publisher.ErrBundleTooLarge):
			writeError(w, http.StatusUnprocessableEntity, err.Error())
		default:
			slog.Error("publish agent failed", "agent_id", agentID, "user_id", userID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to publish agent")
		}
		return
	}
	if result == nil || result.Revision == nil {
		writeError(w, http.StatusInternalServerError, "failed to publish agent")
		return
	}
	revision := result.Revision
	bundleURL := fmt.Sprintf("/api/agents/%s/publications/%d/bundle", agentID, revision.Revision)
	w.Header().Set("Location", bundleURL)
	status := http.StatusCreated
	if result.WasExisting {
		status = http.StatusOK
	}
	writeJSON(w, status, PublishAgentResponse{
		DeploymentID: revision.DeploymentID,
		Revision:     revision.Revision,
		ConfigHash:   revision.ConfigHash,
		WasExisting:  result.WasExisting,
		CreatedAt:    revision.CreatedAt.UTC().Format(time.RFC3339Nano),
		BundleURL:    bundleURL,
	})
}

func (h *PublicationHandler) GetBundle(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	revisionNumber, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || revisionNumber <= 0 {
		writeError(w, http.StatusBadRequest, "revision must be a positive integer")
		return
	}
	deploymentID := r.PathValue("id")
	revision, err := h.service.GetBundle(r.Context(), userID, deploymentID, revisionNumber)
	if err != nil {
		if errors.Is(err, deployment.ErrRevisionNotFound) {
			writeError(w, http.StatusNotFound, "deployment revision not found")
			return
		}
		slog.Error("get deployment bundle failed", "deployment_id", deploymentID, "revision", revisionNumber, "user_id", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load deployment bundle")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="deployment-%s-r%d.json"`, deploymentID, revisionNumber))
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(revision.BundleJSON); err != nil {
		slog.Error("write deployment bundle failed", "deployment_id", deploymentID, "revision", revisionNumber, "error", err)
	}
}
