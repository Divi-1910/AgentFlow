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
}

func NewThreadHandler(threadRepo *repository.ThreadRepo) *ThreadHandler {
	return &ThreadHandler{threadRepo: threadRepo}
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

	thread, err := h.threadRepo.Create(r.Context(), userID, r.PathValue("id"), req.Title)
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

	threads, err := h.threadRepo.ListByAgent(r.Context(), r.PathValue("id"), userID)
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
