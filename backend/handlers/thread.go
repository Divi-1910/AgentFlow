package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"backend/model"
	"backend/repository"
)

type ThreadHandler struct {
	threadRepo *repository.ThreadRepo
	agentRepo  *repository.AgentRepo
}

func NewThreadHandler(threadRepo *repository.ThreadRepo, agentRepo *repository.AgentRepo) *ThreadHandler {
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

func toThreadResponse(t *model.ThreadDocument) ThreadResponse {
	return ThreadResponse{
		ID:        t.ID.Hex(),
		AgentID:   t.AgentID.Hex(),
		Title:     t.Title,
		CreatedAt: t.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: t.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func (h *ThreadHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req CreateThreadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
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
