package handlers

import (
	"context"
	"net/http"
	"time"

	"backend/agent"
)

// threadStore is the subset of repository.ThreadRepo used by handlers.
type threadStore interface {
	Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error)
	GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error)
	ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error)
	UpdateSummary(ctx context.Context, threadID, userID, summary string) error
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
	ID        string `json:"id"`
	AgentID   string `json:"agent_id"`
	Title     string `json:"title"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func toThreadResponse(t *agent.ThreadRecord) ThreadResponse {
	return ThreadResponse{
		ID:        t.ID,
		AgentID:   t.AgentID,
		Title:     t.Title,
		CreatedAt: t.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt: t.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (h *ThreadHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req CreateThreadRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	agentID := r.PathValue("id")

	if _, err := h.agentRepo.GetByID(r.Context(), agentID, userID); err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify agent access")
		return
	}

	thread, err := h.threadRepo.Create(r.Context(), userID, agentID, req.Title)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create thread")
		return
	}
	writeJSON(w, http.StatusCreated, toThreadResponse(thread))
}

func (h *ThreadHandler) ListByAgent(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	agentID := r.PathValue("id")

	if _, err := h.agentRepo.GetByID(r.Context(), agentID, userID); err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify agent access")
		return
	}

	threads, err := h.threadRepo.ListByAgent(r.Context(), agentID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list threads")
		return
	}

	resp := make([]ThreadResponse, len(threads))
	for i, t := range threads {
		resp[i] = toThreadResponse(t)
	}
	writeJSON(w, http.StatusOK, resp)
}
