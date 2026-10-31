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
	"backend/pagination"
	"backend/publisher"
)

type publicationService interface {
	Publish(ctx context.Context, userID, rootAgentID, idempotencyKey string) (*publisher.Result, error)
	Restore(ctx context.Context, userID, deploymentID string, sourceRevision int, idempotencyKey string) (*publisher.Result, error)
	GetBundle(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error)
	ListRevisions(ctx context.Context, userID, deploymentID string, limit int) ([]deployment.Revision, error)
}

type publicationPageService interface {
	ListRevisionPage(ctx context.Context, userID, deploymentID string, request deployment.RevisionPageRequest) (deployment.RevisionPage, error)
}

type PublicationHandler struct{ service publicationService }

const IdempotencyKeyHeader = "Idempotency-Key"

func NewPublicationHandler(service publicationService) *PublicationHandler {
	return &PublicationHandler{service: service}
}

type PublishAgentResponse struct {
	DeploymentID   string `json:"deployment_id"`
	Revision       int    `json:"revision"`
	SourceRevision int    `json:"source_revision,omitempty"`
	ConfigHash     string `json:"config_hash"`
	WasExisting    bool   `json:"was_existing"`
	CreatedAt      string `json:"created_at"`
	BundleURL      string `json:"bundle_url"`
}

type PublicationSummary struct {
	DeploymentID   string `json:"deployment_id"`
	RootAgentID    string `json:"root_agent_id"`
	Revision       int    `json:"revision"`
	SourceRevision int    `json:"source_revision,omitempty"`
	ConfigHash     string `json:"config_hash"`
	SchemaVersion  int    `json:"schema_version"`
	CreatedAt      string `json:"created_at"`
	BundleURL      string `json:"bundle_url"`
}

func (h *PublicationHandler) Publish(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	agentID := r.PathValue("id")
	idempotencyKeys := r.Header.Values(IdempotencyKeyHeader)
	if len(idempotencyKeys) != 1 {
		writeError(w, http.StatusBadRequest, "exactly one Idempotency-Key header is required")
		return
	}
	idempotencyKey := idempotencyKeys[0]
	if err := deployment.ValidateRevisionIdempotencyKey(idempotencyKey); err != nil {
		writeError(w, http.StatusBadRequest, "Idempotency-Key must contain 1 to 128 visible ASCII characters without whitespace")
		return
	}
	result, err := h.service.Publish(r.Context(), userID, agentID, idempotencyKey)
	h.writePublicationResult(w, agentID, resourceAPIBase(r), result, err, "publish")
}

func (h *PublicationHandler) Restore(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	deploymentID := r.PathValue("id")
	sourceRevision, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || sourceRevision <= 0 {
		writeError(w, http.StatusBadRequest, "revision must be a positive integer")
		return
	}
	idempotencyKeys := r.Header.Values(IdempotencyKeyHeader)
	if len(idempotencyKeys) != 1 {
		writeError(w, http.StatusBadRequest, "exactly one Idempotency-Key header is required")
		return
	}
	idempotencyKey := idempotencyKeys[0]
	if err := deployment.ValidateRevisionIdempotencyKey(idempotencyKey); err != nil {
		writeError(w, http.StatusBadRequest, "Idempotency-Key must contain 1 to 128 visible ASCII characters without whitespace")
		return
	}
	result, err := h.service.Restore(r.Context(), userID, deploymentID, sourceRevision, idempotencyKey)
	h.writePublicationResult(w, deploymentID, resourceAPIBase(r), result, err, "restore")
}

func (h *PublicationHandler) writePublicationResult(w http.ResponseWriter, deploymentID, resourceBase string, result *publisher.Result, err error, operation string) {
	if err != nil {
		switch {
		case errors.Is(err, publisher.ErrRootAgentNotFound):
			writeError(w, http.StatusNotFound, "agent not found")
		case errors.Is(err, publisher.ErrGraphUnstable):
			writeError(w, http.StatusConflict, "agent graph changed during publication; retry")
		case errors.Is(err, deployment.ErrRevisionIdempotencyConflict):
			writeError(w, http.StatusConflict, "Idempotency-Key was already used for a different publication")
		case errors.Is(err, deployment.ErrRevisionIdempotencyKey):
			writeError(w, http.StatusBadRequest, "invalid Idempotency-Key")
		case errors.Is(err, deployment.ErrRevisionNotFound):
			writeError(w, http.StatusNotFound, "deployment revision not found")
		case errors.Is(err, publisher.ErrInvalidGraph), errors.Is(err, publisher.ErrInvalidBundle), errors.Is(err, publisher.ErrBundleTooLarge):
			writeError(w, http.StatusUnprocessableEntity, err.Error())
		default:
			slog.Error("publication operation failed", "operation", operation, "deployment_id", deploymentID, "error", err)
			writeError(w, http.StatusInternalServerError, "publication operation failed")
		}
		return
	}
	if result == nil || result.Revision == nil {
		writeError(w, http.StatusInternalServerError, "publication operation failed")
		return
	}
	revision := result.Revision
	bundleURL := fmt.Sprintf("%s/%s/publications/%d/bundle", resourceBase, deploymentID, revision.Revision)
	w.Header().Set("Location", bundleURL)
	status := http.StatusCreated
	if result.WasExisting {
		status = http.StatusOK
	}
	writeJSON(w, status, PublishAgentResponse{
		DeploymentID:   revision.DeploymentID,
		Revision:       revision.Revision,
		SourceRevision: revision.SourceRevision,
		ConfigHash:     revision.ConfigHash,
		WasExisting:    result.WasExisting,
		CreatedAt:      revision.CreatedAt.UTC().Format(time.RFC3339Nano),
		BundleURL:      bundleURL,
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
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(revision.BundleJSON); err != nil {
		slog.Error("write deployment bundle failed", "deployment_id", deploymentID, "revision", revisionNumber, "error", err)
	}
}

func (h *PublicationHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	request, ok := parsePage(w, r, "publications", 50)
	if !ok {
		return
	}
	deploymentID := r.PathValue("id")
	pageService, supportsPages := h.service.(publicationPageService)
	var page deployment.RevisionPage
	var err error
	if supportsPages {
		before := 0
		if request.Cursor != nil {
			before = request.Cursor.Number
		}
		page, err = pageService.ListRevisionPage(r.Context(), userID, deploymentID, deployment.RevisionPageRequest{Limit: request.Limit, BeforeRevision: before})
	} else if request.Cursor == nil {
		page.Items, err = h.service.ListRevisions(r.Context(), userID, deploymentID, request.Limit)
	} else {
		err = errors.New("publication pagination is unavailable")
	}
	if err != nil {
		slog.Error("list deployment revisions failed", "deployment_id", deploymentID, "user_id", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to list deployment revisions")
		return
	}
	items := make([]PublicationSummary, len(page.Items))
	for i, revision := range page.Items {
		items[i] = PublicationSummary{
			DeploymentID:   revision.DeploymentID,
			RootAgentID:    revision.RootAgentID,
			Revision:       revision.Revision,
			SourceRevision: revision.SourceRevision,
			ConfigHash:     revision.ConfigHash,
			SchemaVersion:  revision.SchemaVersion,
			CreatedAt:      revision.CreatedAt.UTC().Format(time.RFC3339Nano),
			BundleURL:      fmt.Sprintf("%s/%s/publications/%d/bundle", resourceAPIBase(r), deploymentID, revision.Revision),
		}
	}
	var next *pagination.Cursor
	if page.NextRevision > 0 {
		next = &pagination.Cursor{Kind: "publications", Number: page.NextRevision}
	}
	response, err := pageResponse(items, next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode publication page")
		return
	}
	writeJSON(w, http.StatusOK, response)
}
