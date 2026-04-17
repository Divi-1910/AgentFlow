package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"backend/agent"
	"backend/model"
	"backend/repository"
	"backend/tools"
)

type RunHandler struct {
	agentRepo    *repository.AgentRepo
	threadRepo   *repository.ThreadRepo
	runRepo      agent.CheckpointStore
	runtime      *agent.AgentRuntime
	toolRegistry *tools.ToolRegistry
}

func NewRunHandler(
	agentRepo *repository.AgentRepo,
	threadRepo *repository.ThreadRepo,
	runRepo agent.CheckpointStore,
	runtime *agent.AgentRuntime,
	toolRegistry *tools.ToolRegistry,
) *RunHandler {
	return &RunHandler{
		agentRepo:    agentRepo,
		threadRepo:   threadRepo,
		runRepo:      runRepo,
		runtime:      runtime,
		toolRegistry: toolRegistry,
	}
}

// GetRun returns the current status and metadata of a run.
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

// ResumeRun resumes a resumable run from its latest checkpoint.
func (h *RunHandler) ResumeRun(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "Missing run ID")
		return
	}

	ctx := r.Context()

	// 1. Check if run exists and is resumable
	info, err := h.runRepo.GetRun(ctx, runID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Run not found")
		return
	}

	if info.Status != string(model.RunStatusResumable) {
		writeError(w, http.StatusConflict, fmt.Sprintf("Run is not resumable, current status: %s", info.Status))
		return
	}

	// 2. Atomically claim ownership (concurrency guard)
	claimed, err := h.runRepo.TransitionStatus(ctx, runID, string(model.RunStatusResumable), string(model.RunStatusRunning))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to transition run state")
		return
	}
	if !claimed {
		writeError(w, http.StatusConflict, "Run ownership claim failed (likely resumed concurrently)")
		return
	}

	// 3. Load latest checkpoint
	snapshot, err := h.runRepo.LoadLatest(ctx, runID)
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), "failed to load checkpoint")
		writeError(w, http.StatusInternalServerError, "Failed to load checkpoint")
		return
	}

	// 4. Validate checkpoint structural integrity and tooling mismatch policies
	if err := agent.ValidateSnapshot(snapshot, h.toolRegistry); err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), fmt.Sprintf("snapshot invalid: %v", err))
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Checkpoint validation failed: %v", err))
		return
	}

	// 5. Load associated agent domain to rebuild runtime deps
	ag, err := h.agentRepo.GetByID(ctx, snapshot.Meta.AgentID, "")
	if err != nil {
		_ = h.runRepo.UpdateStatus(ctx, runID, string(model.RunStatusFailed), "agent not found")
		writeError(w, http.StatusInternalServerError, "Agent not found")
		return
	}

	// 6. Increment attempt counter
	newAttempt, err := h.runRepo.IncrementAttempt(ctx, runID)
	if err != nil {
		log.Printf("[resume] failed to increment attempt: %v", err)
		newAttempt = snapshot.Meta.Attempt + 1 // fallback
	}
	snapshot.Meta.Attempt = newAttempt

	// 7. Setup transport
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

	// Build specialized run context for resume
	runCtx := agent.RunContext{
		RunID:      runID,
		ThreadID:   snapshot.Meta.ThreadID,
		Attempt:    newAttempt,
		Checkpoint: snapshot,
	}

	// The rest of the stream consumption looks identical to fresh run.
	// Note: Checkpoint runs skip background summarization because
	// the snapshot embeds its own summary truth.
	
	type outcome struct {
		res *agent.RunResult
		err error
	}
	done := make(chan outcome, 1)

	go func() {
		res, err := h.runtime.RunStream(runCtxStream, ag, runCtx, events)
		done <- outcome{res, err}
	}()

	for {
		select {
		case ev, ok := <-events:
			if !ok {
				events = nil
				break
			}
			msg, err := json.Marshal(ev)
			if err == nil {
				_, _ = fmt.Fprintf(w, "data: %s\n\n", msg)
				flusher.Flush()
			}
		case <-runCtxStream.Done():
			cancelStream() // signal runtime to stop
			
			// We MUST drain remaining events to unblock runtime
			for range events {
			}
			return
		case out := <-done:
			if out.res != nil && out.err == nil {
				// Terminal state successfully completed in memory
			}
			return
		}
		
		if events == nil {
			break
		}
	}
}
