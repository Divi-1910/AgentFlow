package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"backend/agent"
	"backend/model"
	"backend/runtimectx"
	"backend/tools"
)

type RunHandler struct {
	agentRepo    agentStore
	messageRepo  messageStore
	runRepo      agent.CheckpointStore
	runtime      runtimeExecutor
	toolRegistry *tools.ToolRegistry
}

func NewRunHandler(
	agentRepo agentStore,
	messageRepo messageStore,
	runRepo agent.CheckpointStore,
	runtime runtimeExecutor,
	toolRegistry *tools.ToolRegistry,
) *RunHandler {
	return &RunHandler{
		agentRepo:    agentRepo,
		messageRepo:  messageRepo,
		runRepo:      runRepo,
		runtime:      runtime,
		toolRegistry: toolRegistry,
	}
}

func (h *RunHandler) GetRun(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "Missing run ID")
		return
	}

	info, err := h.runRepo.GetRunForUser(r.Context(), runID, userID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Run not found")
		return
	}

	writeJSON(w, http.StatusOK, info)
}

func (h *RunHandler) ResumeRun(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "Missing run ID")
		return
	}

	ctx := r.Context()

	info, err := h.runRepo.GetRunForUser(ctx, runID, userID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Run not found")
		return
	}

	runLogger := slog.With("run_id", runID, "thread_id", info.ThreadID, "user_id", userID)

	resumableStatuses := map[string]bool{
		string(model.RunStatusResumable):  true,
		string(model.RunStatusInterrupted): true,
	}
	if !resumableStatuses[info.Status] {
		writeError(w, http.StatusConflict, fmt.Sprintf("Run is not resumable, current status: %s", info.Status))
		return
	}

	claimed, err := h.runRepo.TransitionStatusForUser(ctx, runID, userID, info.Status, string(model.RunStatusRunning))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to transition run state")
		return
	}
	if !claimed {
		writeError(w, http.StatusConflict, "Run ownership claim failed (likely resumed concurrently)")
		return
	}

	snapshot, err := h.runRepo.LoadLatest(ctx, runID)
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), "failed to load checkpoint")
		writeError(w, http.StatusInternalServerError, "Failed to load checkpoint")
		return
	}

	if err := agent.ValidateSnapshot(snapshot, h.toolRegistry); err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), fmt.Sprintf("snapshot invalid: %v", err))
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Checkpoint validation failed: %v", err))
		return
	}
	if warning := agent.ToolsetVersionWarning(snapshot.Meta, h.toolRegistry); warning != "" {
		runLogger.Warn("toolset version changed", "warning", warning)
	}

	ag, err := h.agentRepo.GetByIDSystem(ctx, snapshot.Meta.AgentID)
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), fmt.Sprintf("failed to load agent: %v", err))
		writeError(w, http.StatusInternalServerError, "Failed to load agent for resume")
		return
	}

	newAttempt, err := h.runRepo.IncrementAttempt(ctx, runID)
	if err != nil {
		runLogger.Warn("failed to increment attempt, using fallback", "error", err)
		newAttempt = snapshot.Meta.Attempt + 1 // fallback
	}
	snapshot.Meta.Attempt = newAttempt

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	runCtxStream, cancelStream := context.WithCancel(ctx)
	defer cancelStream()

	events := make(chan agent.StreamEvent, 128)
	done := make(chan runOutcome, 1)

	runCtx := agent.RunContext{
		RunID:      runID,
		ThreadID:   snapshot.Meta.ThreadID,
		Attempt:    newAttempt,
		Checkpoint: snapshot,
		Summary:    snapshot.State.RawSummary,
		Memory: runtimectx.MemoryScope{
			UserID:   userID,
			AgentID:  snapshot.Meta.AgentID,
			ThreadID: snapshot.Meta.ThreadID,
		},
		Logger: runLogger,
	}

	go func() {
		var (
			res    *agent.RunResult
			runErr error
		)
		defer func() {
			if rec := recover(); rec != nil {
				runLogger.Error("panic in RunStream", "error", rec)
				runErr = fmt.Errorf("panic in stream execution: %v", rec)
			}
			done <- runOutcome{res, runErr}
		}()
		res, runErr = h.runtime.RunStream(runCtxStream, ag, runCtx, events)
	}()

	sr := streamLoop(runCtxStream, cancelStream, w, flusher, events, done, runLogger)
	out := sr.out

	if out.res != nil {
		persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelPersist()

		savedDocs, insertErr := h.messageRepo.InsertMany(
			persistCtx,
			snapshot.Meta.ThreadID,
			snapshot.Meta.AgentID,
			userID,
			out.res.NewMessages,
		)
		if insertErr != nil {
			runLogger.Error("message persist failed", "attempt", newAttempt, "thread_id", snapshot.Meta.ThreadID, "error", insertErr)
			if !sr.clientDisconnected {
				emitEvent(w, flusher, agent.StreamEvent{
					Type:  agent.EventRunPersistFail,
					Time:  time.Now(),
					Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
				})
			}
		} else {
			runLogger.Info("messages persisted", "attempt", newAttempt, "steps", out.res.Steps, "thread_id", snapshot.Meta.ThreadID, "messages", len(savedDocs))
			if !sr.clientDisconnected {
				emitEvent(w, flusher, agent.StreamEvent{Type: agent.EventRunPersisted, Time: time.Now()})
			}
		}
	}

	if sr.terminalEvent != nil && !sr.clientDisconnected {
		emitEvent(w, flusher, *sr.terminalEvent)
	}
}
