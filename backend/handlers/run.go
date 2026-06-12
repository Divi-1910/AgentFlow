package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"backend/agent"
	"backend/dispatcher"
	"backend/model"
	"backend/tools"
)

type RunHandler struct {
	agentRepo    agentStore
	messageRepo  messageStore
	runRepo      agent.CheckpointStore
	dispatcher   dispatcher.Dispatcher
	toolRegistry *tools.ToolRegistry
}

func NewRunHandler(
	agentRepo agentStore,
	messageRepo messageStore,
	runRepo agent.CheckpointStore,
	disp dispatcher.Dispatcher,
	toolRegistry *tools.ToolRegistry,
) *RunHandler {
	return &RunHandler{
		agentRepo:    agentRepo,
		messageRepo:  messageRepo,
		runRepo:      runRepo,
		dispatcher:   disp,
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
		string(model.RunStatusResumable):   true,
		string(model.RunStatusInterrupted): true,
		string(model.RunStatusWaitingJobs): true,
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
	// A nil snapshot can't carry an agent id to load; treat it as an invalid
	// checkpoint (the same 422 ValidateSnapshot would return).
	if snapshot == nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), "snapshot missing")
		writeError(w, http.StatusUnprocessableEntity, "Checkpoint validation failed: snapshot is nil")
		return
	}

	// Load the agent first so the effective tool set (delegates included) can
	// be built for snapshot validation.
	resumeAgent, err := h.agentRepo.GetByIDSystem(ctx, snapshot.Meta.AgentID)
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), fmt.Sprintf("failed to load agent: %v", err))
		writeError(w, http.StatusInternalServerError, "Failed to load agent for resume")
		return
	}

	toolSet, err := agent.BuildToolSetForValidation(h.toolRegistry, resumeAgent)
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), fmt.Sprintf("tool set invalid: %v", err))
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Tool set build failed: %v", err))
		return
	}
	if err := agent.ValidateSnapshot(snapshot, toolSet); err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), fmt.Sprintf("snapshot invalid: %v", err))
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Checkpoint validation failed: %v", err))
		return
	}
	if warning := agent.ToolsetCosmeticWarning(snapshot.Meta, toolSet); warning != "" {
		runLogger.Warn("toolset cosmetic drift", "warning", warning)
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
	dispatchReq := dispatcher.DispatchRequest{
		RunID:    runID,
		AgentID:  snapshot.Meta.AgentID,
		ThreadID: snapshot.Meta.ThreadID,
		UserID:   userID,
		IsResume: true,
		Attempt:  newAttempt,
		Logger:   runLogger,
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
		res, runErr = h.dispatcher.Dispatch(runCtxStream, dispatchReq, events)
	}()

	sr := streamLoop(runCtxStream, cancelStream, w, flusher, events, done, runLogger)
	out := sr.out

	if out.res != nil {
		if len(out.res.NewMessages) == 0 {
			if !sr.clientDisconnected {
				emitEvent(w, flusher, agent.StreamEvent{Type: agent.EventRunPersisted, Time: time.Now()})
			}
		} else {
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
	}

	if sr.terminalEvent != nil && !sr.clientDisconnected {
		emitEvent(w, flusher, *sr.terminalEvent)
	}
}
