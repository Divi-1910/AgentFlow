package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"backend/agent"
	"backend/model"
	"backend/repository"
	"backend/tools"
)

type RunHandler struct {
	agentRepo    *repository.AgentRepo
	threadRepo   *repository.ThreadRepo
	messageRepo  *repository.MessageRepo
	runRepo      agent.CheckpointStore
	runtime      *agent.AgentRuntime
	toolRegistry *tools.ToolRegistry
}

func NewRunHandler(
	agentRepo *repository.AgentRepo,
	threadRepo *repository.ThreadRepo,
	messageRepo *repository.MessageRepo,
	runRepo agent.CheckpointStore,
	runtime *agent.AgentRuntime,
	toolRegistry *tools.ToolRegistry,
) *RunHandler {
	return &RunHandler{
		agentRepo:    agentRepo,
		threadRepo:   threadRepo,
		messageRepo:  messageRepo,
		runRepo:      runRepo,
		runtime:      runtime,
		toolRegistry: toolRegistry,
	}
}

func (h *RunHandler) GetRun(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "Missing run ID")
		return
	}

	info, err := h.runRepo.GetRun(r.Context(), runID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Run not found")
		return
	}

	writeJSON(w, http.StatusOK, info)
}

func (h *RunHandler) ResumeRun(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "Missing run ID")
		return
	}

	ctx := r.Context()

	info, err := h.runRepo.GetRun(ctx, runID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Run not found")
		return
	}

	if info.Status != string(model.RunStatusResumable) {
		writeError(w, http.StatusConflict, fmt.Sprintf("Run is not resumable, current status: %s", info.Status))
		return
	}

	claimed, err := h.runRepo.TransitionStatus(ctx, runID, string(model.RunStatusResumable), string(model.RunStatusRunning))
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

	ag, err := h.agentRepo.GetByID(ctx, snapshot.Meta.AgentID, "")
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), "agent not found")
		writeError(w, http.StatusInternalServerError, "Agent not found")
		return
	}

	newAttempt, err := h.runRepo.IncrementAttempt(ctx, runID)
	if err != nil {
		log.Printf("[resume] failed to increment attempt: %v", err)
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

	runCtx := agent.RunContext{
		RunID:      runID,
		ThreadID:   snapshot.Meta.ThreadID,
		Attempt:    newAttempt,
		Checkpoint: snapshot,
	}

	type outcome struct {
		res *agent.RunResult
		err error
	}
	done := make(chan outcome, 1)

	go func() {
		var (
			res    *agent.RunResult
			runErr error
		)
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[resume] panic in RunStream: %v", rec)
				runErr = fmt.Errorf("panic in stream execution: %v", rec)
			}
			done <- outcome{res, runErr}
		}()
		res, runErr = h.runtime.RunStream(runCtxStream, ag, runCtx, events)
	}()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	var terminalEvent *agent.StreamEvent
	clientDisconnected := false

loop:
	for {
		select {
		case <-runCtxStream.Done():
			break loop
		case <-ticker.C:
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				clientDisconnected = true
				cancelStream()
				break loop
			}
			flusher.Flush()
		case e, ok := <-events:
			if !ok {
				break loop
			}
			if e.Type == agent.EventRunCompleted || e.Type == agent.EventRunFailed ||
				e.Type == agent.EventRunCancelled || e.Type == agent.EventRunResumed {
				if terminalEvent == nil || e.Type != agent.EventRunResumed {
					terminalEvent = &e
				}

				if e.Type == agent.EventRunResumed {
					data, _ := json.Marshal(e)
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					flusher.Flush()
					continue
				}
				continue
			}
			data, merr := json.Marshal(e)
			if merr != nil {
				continue
			}
			if _, ferr := fmt.Fprintf(w, "data: %s\n\n", data); ferr != nil {
				clientDisconnected = true
				cancelStream()
				break loop
			}
			flusher.Flush()
		}
	}

	out := <-done

	// Drain any remaining events before deciding on terminal state
draining:
	for {
		select {
		case e, ok := <-events:
			if !ok {
				break draining
			}
			if e.Type == agent.EventRunCompleted || e.Type == agent.EventRunFailed || e.Type == agent.EventRunCancelled {
				if terminalEvent == nil {
					terminalEvent = &e
				}
			}
		default:
			break draining
		}
	}

	if out.err != nil && terminalEvent == nil {
		terminalEvent = &agent.StreamEvent{
			Type:  agent.EventRunFailed,
			Time:  time.Now(),
			Error: &agent.ErrMeta{Code: "engine.runtime_error", Message: out.err.Error()},
		}
	}

	if terminalEvent != nil && !clientDisconnected {
		data, _ := json.Marshal(terminalEvent)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	if out.res != nil {
		persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelPersist()

		allMessages := out.res.NewMessages

		docs, persistErr := h.threadRepo.GetByID(persistCtx, snapshot.Meta.ThreadID, "")
		if persistErr == nil && docs != nil {
			savedDocs, insertErr := h.messageRepo.InsertMany(
				persistCtx,
				snapshot.Meta.ThreadID,
				docs.AgentID.Hex(),
				ag.ID,
				allMessages,
			)
			if insertErr != nil {
				log.Printf("[resume] persist failed attempt=%d thread=%s err=%v", newAttempt, snapshot.Meta.ThreadID, insertErr)
				if !clientDisconnected {
					persistFailEvent := agent.StreamEvent{
						Type:  agent.EventRunPersistFail,
						Time:  time.Now(),
						Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
					}
					data, _ := json.Marshal(persistFailEvent)
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					flusher.Flush()
				}
			} else {
				log.Printf("[resume] persisted attempt=%d steps=%d thread=%s messages=%d",
					newAttempt, out.res.Steps, snapshot.Meta.ThreadID, len(savedDocs))
				if !clientDisconnected {
					persistedEvent := agent.StreamEvent{
						Type: agent.EventRunPersisted,
						Time: time.Now(),
					}
					data, _ := json.Marshal(persistedEvent)
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					flusher.Flush()
				}
			}
		}
	}
}
