package handlers

import (
	"context"
	"net/http"
	"time"

	"backend/agent"
)

type threadJobStore interface {
	ListByParentThreadForUser(ctx context.Context, threadID, userID string, limit int) ([]agent.JobRecord, error)
}

type JobHandler struct {
	threads threadStore
	jobs    threadJobStore
}

func NewJobHandler(threads threadStore, jobs threadJobStore) *JobHandler {
	return &JobHandler{threads: threads, jobs: jobs}
}

type JobResponse struct {
	ID             string `json:"id"`
	ParentRunID    string `json:"parent_run_id"`
	DelegateTool   string `json:"delegate_tool"`
	TargetAgentID  string `json:"target_agent_id"`
	Task           string `json:"task"`
	Mode           string `json:"mode"`
	Status         string `json:"status"`
	Error          string `json:"error,omitempty"`
	CallbackStatus string `json:"callback_status"`
	CallbackError  string `json:"callback_error,omitempty"`
	CallbackRunID  string `json:"callback_run_id,omitempty"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

func toJobResponse(job agent.JobRecord) JobResponse {
	return JobResponse{
		ID:             job.JobID,
		ParentRunID:    job.ParentRunID,
		DelegateTool:   job.DelegateTool,
		TargetAgentID:  job.TargetAgentID,
		Task:           job.Task,
		Mode:           job.Mode,
		Status:         job.Status,
		Error:          job.Error,
		CallbackStatus: job.CallbackStatus,
		CallbackError:  job.CallbackError,
		CallbackRunID:  job.CallbackRunID,
		CreatedAt:      job.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:      job.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// ListByThread exposes only jobs whose parent is the requested user-owned
// thread. It deliberately omits child-thread contents and raw job output; the
// callback persists the user-facing result into the ordinary transcript.
func (h *JobHandler) ListByThread(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	threadID := r.PathValue("id")
	if threadID == "" {
		writeError(w, http.StatusBadRequest, "thread id is required")
		return
	}
	if _, err := h.threads.GetByID(r.Context(), threadID, userID); err != nil {
		writeError(w, http.StatusNotFound, "thread not found")
		return
	}
	jobs, err := h.jobs.ListByParentThreadForUser(r.Context(), threadID, userID, parseLimit(r, 50, 200))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load background work")
		return
	}
	items := make([]JobResponse, 0, len(jobs))
	for _, job := range jobs {
		items = append(items, toJobResponse(job))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
