package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"backend/agent"
	"backend/pagination"
)

var errResourceKindMismatch = errors.New("resource kind mismatch")

// threadStore is the subset of mongorepo.ThreadRepo used by handlers.
type threadStore interface {
	Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error)
	GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error)
	ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error)
	UpdateTitle(ctx context.Context, threadID, userID, title string) error
	UpdateSummary(ctx context.Context, threadID, userID, summary string) error
}

type threadPageStore interface {
	ListByAgentPage(ctx context.Context, agentID, userID string, request pagination.Request) (pagination.Page[*agent.ThreadRecord], error)
	ListByUserPage(ctx context.Context, userID string, resourceIDs []string, request pagination.Request) (pagination.Page[*agent.ThreadRecord], error)
}

type threadActivityStore interface {
	Touch(ctx context.Context, threadID, userID string) error
}

type ownedResourceLister interface {
	ListByUser(ctx context.Context, userID string) ([]*agent.Agent, error)
}

type ThreadHandler struct {
	threadRepo threadStore
	agentRepo  agentReader
}

func NewThreadHandler(threadRepo threadStore, agentRepo agentReader) *ThreadHandler {
	return &ThreadHandler{
		threadRepo: threadRepo,
		agentRepo:  agentRepo,
	}
}

type CreateThreadRequest struct {
	Title string `json:"title"`
}

type ThreadResponse struct {
	ID           string             `json:"id"`
	AgentID      string             `json:"agent_id"`
	ResourceID   string             `json:"resource_id"`
	ResourceKind agent.ResourceKind `json:"resource_kind"`
	Title        string             `json:"title"`
	CreatedAt    string             `json:"created_at"`
	UpdatedAt    string             `json:"updated_at"`
}

func toThreadResponse(t *agent.ThreadRecord, resourceKind agent.ResourceKind) ThreadResponse {
	return ThreadResponse{
		ID:           t.ID,
		AgentID:      t.AgentID,
		ResourceID:   t.AgentID,
		ResourceKind: resourceKind,
		Title:        t.Title,
		CreatedAt:    t.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:    t.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (h *ThreadHandler) Create(w http.ResponseWriter, r *http.Request) {
	h.createForResource(w, r, r.PathValue("id"), agent.ResourceKindStandaloneAgent)
}

func (h *ThreadHandler) CreateForTeam(w http.ResponseWriter, r *http.Request) {
	h.createForResource(w, r, r.PathValue("id"), agent.ResourceKindAgentTeam)
}

// CreateForAgent binds thread creation to a frozen agent id. The standalone
// runtime uses this for its root agent while Studio keeps the path-based API.
func (h *ThreadHandler) CreateForAgent(agentID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.createForResource(w, r, agentID, "")
	}
}

func (h *ThreadHandler) createForResource(w http.ResponseWriter, r *http.Request, agentID string, expectedKind agent.ResourceKind) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req CreateThreadRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	resource, err := h.loadOwnedResource(r.Context(), agentID, userID, expectedKind)
	if err != nil {
		if err.Error() == "agent not found" || errors.Is(err, errResourceKindMismatch) {
			writeError(w, http.StatusNotFound, resourceNotFoundMessage(expectedKind))
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify agent access")
		return
	}

	thread, err := h.threadRepo.Create(r.Context(), userID, agentID, strings.TrimSpace(req.Title))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create thread")
		return
	}
	writeJSON(w, http.StatusCreated, toThreadResponse(thread, agent.EffectiveResourceKind(resource)))
}

func (h *ThreadHandler) ListByAgent(w http.ResponseWriter, r *http.Request) {
	h.listByResource(w, r, r.PathValue("id"), agent.ResourceKindStandaloneAgent)
}

func (h *ThreadHandler) ListByTeam(w http.ResponseWriter, r *http.Request) {
	h.listByResource(w, r, r.PathValue("id"), agent.ResourceKindAgentTeam)
}

func (h *ThreadHandler) ListForAgent(agentID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.listByResource(w, r, agentID, "")
	}
}

// List returns the authenticated user's conversations across Agents and Agent
// Teams. Optional resource_id and resource_kind filters are ownership checked
// before the thread repository is queried.
func (h *ThreadHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	request, ok := parsePage(w, r, "threads", 50)
	if !ok {
		return
	}
	resourceID := strings.TrimSpace(r.URL.Query().Get("resource_id"))
	kindRaw := strings.TrimSpace(r.URL.Query().Get("resource_kind"))
	var expectedKind agent.ResourceKind
	if kindRaw != "" {
		expectedKind = agent.ResourceKind(kindRaw)
		if expectedKind != agent.ResourceKindStandaloneAgent && expectedKind != agent.ResourceKindAgentTeam {
			writeError(w, http.StatusBadRequest, "resource_kind must be standalone_agent or agent_team")
			return
		}
	}
	var resourceIDs []string
	if resourceID != "" {
		resource, err := h.agentRepo.GetByID(r.Context(), resourceID, userID)
		if err != nil || (expectedKind != "" && agent.EffectiveResourceKind(resource) != expectedKind) {
			writeError(w, http.StatusNotFound, resourceNotFoundMessage(expectedKind))
			return
		}
		resourceIDs = []string{resourceID}
	} else if expectedKind != "" {
		lister, ok := h.agentRepo.(ownedResourceLister)
		if !ok {
			writeError(w, http.StatusInternalServerError, "resource listing is unavailable")
			return
		}
		resources, err := lister.ListByUser(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list resources")
			return
		}
		resourceIDs = []string{}
		for _, resource := range resources {
			if agent.EffectiveResourceKind(resource) == expectedKind {
				resourceIDs = append(resourceIDs, resource.ID)
			}
		}
	}
	pages, ok := h.threadRepo.(threadPageStore)
	if !ok {
		writeError(w, http.StatusInternalServerError, "thread pagination is unavailable")
		return
	}
	page, err := pages.ListByUserPage(r.Context(), userID, resourceIDs, request)
	if err != nil {
		if errors.Is(err, pagination.ErrInvalidCursor) {
			writeError(w, http.StatusBadRequest, "invalid cursor")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to list threads")
		return
	}
	items := make([]ThreadResponse, len(page.Items))
	for i, thread := range page.Items {
		kind := agent.ResourceKind("")
		if resource, err := h.agentRepo.GetByID(r.Context(), thread.AgentID, userID); err == nil {
			kind = agent.EffectiveResourceKind(resource)
		}
		items[i] = toThreadResponse(thread, kind)
	}
	response, err := pageResponse(items, page.Next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode thread page")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *ThreadHandler) listByResource(w http.ResponseWriter, r *http.Request, agentID string, expectedKind agent.ResourceKind) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	resource, err := h.loadOwnedResource(r.Context(), agentID, userID, expectedKind)
	if err != nil {
		if err.Error() == "agent not found" || errors.Is(err, errResourceKindMismatch) {
			writeError(w, http.StatusNotFound, resourceNotFoundMessage(expectedKind))
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify agent access")
		return
	}

	request, ok := parsePage(w, r, "threads", 50)
	if !ok {
		return
	}
	pages, ok := h.threadRepo.(threadPageStore)
	if !ok {
		writeError(w, http.StatusInternalServerError, "thread pagination is unavailable")
		return
	}
	page, err := pages.ListByAgentPage(r.Context(), agentID, userID, request)
	if err != nil {
		if errors.Is(err, pagination.ErrInvalidCursor) {
			writeError(w, http.StatusBadRequest, "invalid cursor")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to list threads")
		return
	}

	resp := make([]ThreadResponse, len(page.Items))
	for i, t := range page.Items {
		resp[i] = toThreadResponse(t, agent.EffectiveResourceKind(resource))
	}
	response, err := pageResponse(resp, page.Next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode thread page")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *ThreadHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	thread, resource, ok := h.loadOwnedThreadAndResource(w, r, userID)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, toThreadResponse(thread, agent.EffectiveResourceKind(resource)))
}

type UpdateThreadRequest struct {
	Title *string `json:"title"`
}

func (h *ThreadHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	thread, resource, ok := h.loadOwnedThreadAndResource(w, r, userID)
	if !ok {
		return
	}

	var req UpdateThreadRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Title == nil || strings.TrimSpace(*req.Title) == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	title := strings.TrimSpace(*req.Title)
	if err := h.threadRepo.UpdateTitle(r.Context(), thread.ID, userID, title); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update thread")
		return
	}
	updatedThread, err := h.threadRepo.GetByID(r.Context(), thread.ID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload updated thread")
		return
	}
	writeJSON(w, http.StatusOK, toThreadResponse(updatedThread, agent.EffectiveResourceKind(resource)))
}

func (h *ThreadHandler) loadOwnedThreadAndResource(w http.ResponseWriter, r *http.Request, userID string) (*agent.ThreadRecord, *agent.Agent, bool) {
	thread, err := h.threadRepo.GetByID(r.Context(), r.PathValue("id"), userID)
	if err != nil {
		if err.Error() == "thread not found" {
			writeError(w, http.StatusNotFound, "thread not found")
			return nil, nil, false
		}
		writeError(w, http.StatusInternalServerError, "failed to load thread")
		return nil, nil, false
	}
	resource, err := h.agentRepo.GetByID(r.Context(), thread.AgentID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load thread resource")
		return nil, nil, false
	}
	return thread, resource, true
}

func (h *ThreadHandler) loadOwnedResource(ctx context.Context, resourceID, userID string, expectedKind agent.ResourceKind) (*agent.Agent, error) {
	resource, err := h.agentRepo.GetByID(ctx, resourceID, userID)
	if err != nil {
		return nil, err
	}
	if expectedKind != "" && agent.EffectiveResourceKind(resource) != expectedKind {
		return nil, errResourceKindMismatch
	}
	return resource, nil
}

func resourceNotFoundMessage(kind agent.ResourceKind) string {
	if kind == agent.ResourceKindAgentTeam {
		return "agent team not found"
	}
	return "agent not found"
}
