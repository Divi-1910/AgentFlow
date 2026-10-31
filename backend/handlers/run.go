package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backend/agent"
	"backend/dispatcher"
	"backend/model"
	"backend/pagination"
	"backend/tools"
)

type runStore interface {
	agent.CheckpointStore
	ListTopLevelByThreadForUser(ctx context.Context, threadID, userID string, limit int) ([]*agent.RunInfo, error)
	ResumeTopLevelRunForUser(ctx context.Context, runID, userID string, from []string) (int, bool, error)
	RequestCancelForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, bool, error)
	FinalizeCancelForUser(ctx context.Context, runID, userID string) (bool, error)
}

type runPageStore interface {
	ListTopLevelPageForUser(ctx context.Context, userID string, filter agent.RunListFilter, request pagination.Request) (pagination.Page[*agent.RunInfo], error)
}

type runTreeCanceller interface {
	CancelRun(originatorRunID string)
}

type RunHandler struct {
	agentRepo    agentReader
	threadRepo   threadStore
	messageRepo  messageStore
	runRepo      runStore
	dispatcher   dispatcher.Dispatcher
	toolRegistry *tools.ToolRegistry
	capabilities agent.ToolCapabilities
	executions   *ExecutionRegistry
}

func NewRunHandler(
	agentRepo agentReader,
	threadRepo threadStore,
	messageRepo messageStore,
	runRepo runStore,
	disp dispatcher.Dispatcher,
	toolRegistry *tools.ToolRegistry,
	capabilities agent.ToolCapabilities,
	registries ...*ExecutionRegistry,
) *RunHandler {
	executions := NewExecutionRegistry()
	if len(registries) > 0 && registries[0] != nil {
		executions = registries[0]
	}
	return &RunHandler{
		agentRepo:    agentRepo,
		threadRepo:   threadRepo,
		messageRepo:  messageRepo,
		runRepo:      runRepo,
		dispatcher:   disp,
		toolRegistry: toolRegistry,
		capabilities: capabilities,
		executions:   executions,
	}
}

type RunResponse struct {
	ID             string             `json:"id"`
	ThreadID       string             `json:"thread_id"`
	AgentID        string             `json:"agent_id"`
	ResourceID     string             `json:"resource_id"`
	ResourceKind   agent.ResourceKind `json:"resource_kind,omitempty"`
	Status         string             `json:"status"`
	Attempt        int                `json:"attempt"`
	StepsCompleted int                `json:"steps_completed"`
	Resumable      bool               `json:"resumable"`
	LastError      string             `json:"last_error,omitempty"`
	CreatedAt      string             `json:"created_at"`
	UpdatedAt      string             `json:"updated_at"`
}

func toRunResponse(info *agent.RunInfo, resourceKind agent.ResourceKind) RunResponse {
	return RunResponse{
		ID:             info.RunID,
		ThreadID:       info.ThreadID,
		AgentID:        info.AgentID,
		ResourceID:     info.AgentID,
		ResourceKind:   resourceKind,
		Status:         info.Status,
		Attempt:        info.Attempt,
		StepsCompleted: info.StepsCompleted,
		Resumable:      isResumableStatus(info.Status),
		LastError:      info.LastError,
		CreatedAt:      info.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:      info.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func isResumableStatus(status string) bool {
	switch model.RunStatus(status) {
	case model.RunStatusResumable, model.RunStatusInterrupted, model.RunStatusWaitingJobs:
		return true
	default:
		return false
	}
}

func (h *RunHandler) CancelRun(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "run id is required")
		return
	}

	info, claimed, err := h.runRepo.RequestCancelForUser(r.Context(), runID, userID)
	if err != nil {
		if strings.Contains(err.Error(), "run not found") {
			writeError(w, http.StatusNotFound, "run not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to request cancellation")
		return
	}
	if !claimed {
		if info.Status == string(model.RunStatusCancelled) {
			writeJSON(w, http.StatusOK, toRunResponse(info, h.resourceKind(r.Context(), info.AgentID, userID)))
			return
		}
		if info.Status != string(model.RunStatusCancelling) {
			writeError(w, http.StatusConflict, fmt.Sprintf("Run cannot be cancelled, current status: %s", info.Status))
			return
		}
	}

	if canceller, ok := h.dispatcher.(runTreeCanceller); ok {
		canceller.CancelRun(runID)
	}
	waitCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	_, stopped := h.executions.CancelAndWait(waitCtx, runID)
	mayBeExecuting := info.DispatchStarted &&
		(info.Status == string(model.RunStatusRunning) || info.Status == string(model.RunStatusCancelling))
	if stopped || !mayBeExecuting {
		if _, err := h.runRepo.FinalizeCancelForUser(context.Background(), runID, userID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to finalize cancellation")
			return
		}
	}
	updated, err := h.runRepo.GetRunForUser(r.Context(), runID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load cancelled run")
		return
	}
	status := http.StatusOK
	if updated.Status == string(model.RunStatusCancelling) {
		status = http.StatusAccepted
	}
	writeJSON(w, status, toRunResponse(updated, h.resourceKind(r.Context(), updated.AgentID, userID)))
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

	writeJSON(w, http.StatusOK, toRunResponse(info, h.resourceKind(r.Context(), info.AgentID, userID)))
}

// StreamEvents attaches an authenticated observer to a runtime-owned top-level
// run. Last-Event-ID uses the delivery identity "<run_id>:<stream_seq>"; it is
// intentionally separate from the execution engine's event ID and sequence.
func (h *RunHandler) StreamEvents(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	runID := r.PathValue("id")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "run id is required")
		return
	}
	info, err := h.runRepo.GetRunForUser(r.Context(), runID, userID)
	if err != nil || info == nil || info.ParentRunID != "" ||
		(info.InvocationKind != "" && info.InvocationKind != agent.InvocationTopLevel) {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	afterSeq, err := parseLastEventID(runID, r.Header.Get("Last-Event-ID"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
	}
	subscription, exists := h.executions.Subscribe(runID, afterSeq)
	if !exists {
		writeError(w, http.StatusGone, "run event stream is no longer available; reload run and message state")
		return
	}
	writeSSEHeaders(w)
	serveSubscription(r.Context(), w, flusher, subscription)
}

func parseLastEventID(runID, value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	prefix := runID + ":"
	if !strings.HasPrefix(value, prefix) {
		return 0, fmt.Errorf("Last-Event-ID does not belong to this run")
	}
	sequence, err := strconv.ParseInt(strings.TrimPrefix(value, prefix), 10, 64)
	if err != nil || sequence < 0 {
		return 0, fmt.Errorf("Last-Event-ID has an invalid stream sequence")
	}
	return sequence, nil
}

func (h *RunHandler) ListByThread(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	threadID := r.PathValue("id")
	thread, err := h.threadRepo.GetByID(r.Context(), threadID, userID)
	if err != nil {
		if err.Error() == "thread not found" {
			writeError(w, http.StatusNotFound, "thread not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify thread access")
		return
	}

	request, ok := parsePage(w, r, "runs", 50)
	if !ok {
		return
	}
	pages, ok := h.runRepo.(runPageStore)
	if !ok {
		writeError(w, http.StatusInternalServerError, "run pagination is unavailable")
		return
	}
	page, err := pages.ListTopLevelPageForUser(r.Context(), userID, agent.RunListFilter{ThreadID: threadID}, request)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list runs")
		return
	}
	kind := h.resourceKind(r.Context(), thread.AgentID, userID)
	items := make([]RunResponse, len(page.Items))
	for i, info := range page.Items {
		items[i] = toRunResponse(info, kind)
	}
	response, err := pageResponse(items, page.Next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode run page")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// List returns top-level runs owned by the authenticated user. Internal child
// runs remain behind the execution boundary and are never projected here.
func (h *RunHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	request, ok := parsePage(w, r, "runs", 50)
	if !ok {
		return
	}
	filter := agent.RunListFilter{
		ThreadID:   strings.TrimSpace(r.URL.Query().Get("thread_id")),
		ResourceID: strings.TrimSpace(r.URL.Query().Get("resource_id")),
	}
	if filter.ThreadID != "" {
		if _, err := h.threadRepo.GetByID(r.Context(), filter.ThreadID, userID); err != nil {
			writeError(w, http.StatusNotFound, "thread not found")
			return
		}
	}
	if filter.ResourceID != "" {
		if _, err := h.agentRepo.GetByID(r.Context(), filter.ResourceID, userID); err != nil {
			writeError(w, http.StatusNotFound, "resource not found")
			return
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("status")); raw != "" {
		seen := map[string]struct{}{}
		for _, value := range strings.Split(raw, ",") {
			status := strings.TrimSpace(value)
			if !isPublicRunStatus(status) {
				writeError(w, http.StatusBadRequest, "invalid run status")
				return
			}
			if _, exists := seen[status]; !exists {
				seen[status] = struct{}{}
				filter.Statuses = append(filter.Statuses, status)
			}
		}
	}
	pages, ok := h.runRepo.(runPageStore)
	if !ok {
		writeError(w, http.StatusInternalServerError, "run pagination is unavailable")
		return
	}
	page, err := pages.ListTopLevelPageForUser(r.Context(), userID, filter, request)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list runs")
		return
	}
	items := make([]RunResponse, len(page.Items))
	for i, info := range page.Items {
		items[i] = toRunResponse(info, h.resourceKind(r.Context(), info.AgentID, userID))
	}
	response, err := pageResponse(items, page.Next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode run page")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func isPublicRunStatus(status string) bool {
	switch model.RunStatus(status) {
	case model.RunStatusRunning, model.RunStatusCancelling, model.RunStatusCompleted,
		model.RunStatusFailed, model.RunStatusCancelled, model.RunStatusResumable,
		model.RunStatusInterrupted, model.RunStatusWaitingJobs:
		return true
	default:
		return false
	}
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

	if !isResumableStatus(info.Status) {
		writeError(w, http.StatusConflict, fmt.Sprintf("Run is not resumable, current status: %s", info.Status))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
	}

	newAttempt, claimed, err := h.runRepo.ResumeTopLevelRunForUser(ctx, runID, userID, []string{info.Status})
	if err != nil {
		if errors.Is(err, agent.ErrThreadRunActive) {
			writeError(w, http.StatusConflict, "thread already has an active run")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to transition run state")
		return
	}
	if !claimed {
		writeError(w, http.StatusConflict, "Run ownership claim failed (likely resumed concurrently)")
		return
	}
	// The resume claim is already durable. From this point onward, browser
	// cancellation must not strand a run in running state, so preparation is
	// detached from the request. The execution itself is rooted in the registry.
	prepareCtx := context.WithoutCancel(ctx)

	snapshot, err := h.runRepo.LoadLatest(prepareCtx, runID)
	if err != nil {
		_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), "failed to load checkpoint")
		writeError(w, http.StatusInternalServerError, "Failed to load checkpoint")
		return
	}
	// A nil snapshot can't carry an agent id to load; treat it as an invalid
	// checkpoint (the same 422 ValidateSnapshot would return).
	if snapshot == nil {
		_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), "snapshot missing")
		writeError(w, http.StatusUnprocessableEntity, "Checkpoint validation failed: snapshot is nil")
		return
	}

	// Load the agent first so the effective tool set (delegates included) can
	// be built for snapshot validation.
	resumeAgent, err := h.agentRepo.GetByIDSystem(prepareCtx, snapshot.Meta.AgentID)
	if err != nil {
		_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), fmt.Sprintf("failed to load agent: %v", err))
		writeError(w, http.StatusInternalServerError, "Failed to load agent for resume")
		return
	}
	if snapshot.Meta.TeamID != "" {
		team, teamErr := h.agentRepo.GetByIDSystem(prepareCtx, snapshot.Meta.TeamID)
		if teamErr != nil {
			_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), fmt.Sprintf("failed to load team: %v", teamErr))
			writeError(w, http.StatusInternalServerError, "Failed to load team for resume")
			return
		}
		resumeAgent, err = agent.EffectiveTeamAgent(team, resumeAgent, snapshot.Meta.AgentID)
		if err != nil {
			_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), fmt.Sprintf("failed to resolve team agent: %v", err))
			writeError(w, http.StatusUnprocessableEntity, "Team graph is no longer valid for this checkpoint")
			return
		}
	}

	toolSet, err := agent.BuildToolSetForValidation(h.toolRegistry, resumeAgent, h.capabilities)
	if err != nil {
		_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), fmt.Sprintf("tool set invalid: %v", err))
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Tool set build failed: %v", err))
		return
	}
	if err := agent.ValidateSnapshot(snapshot, toolSet); err != nil {
		_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), fmt.Sprintf("snapshot invalid: %v", err))
		writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("Checkpoint validation failed: %v", err))
		return
	}
	if warning := agent.ToolsetCosmeticWarning(snapshot.Meta, toolSet); warning != "" {
		runLogger.Warn("toolset cosmetic drift", "warning", warning)
	}

	snapshot.Meta.Attempt = newAttempt
	dispatchReq := dispatcher.DispatchRequest{
		RunID:    runID,
		AgentID:  snapshot.Meta.AgentID,
		TeamID:   snapshot.Meta.TeamID,
		ThreadID: snapshot.Meta.ThreadID,
		UserID:   userID,
		IsResume: true,
		Attempt:  newAttempt,
		Logger:   runLogger,
	}
	resumeAfterSeq := h.executions.LatestStreamSequence(runID)
	started, startErr := h.executions.Start(runID, func(runCtx context.Context, publish func(agent.StreamEvent)) {
		h.executeResumedRun(runCtx, publish, dispatchReq, snapshot, userID, newAttempt, runLogger)
	})
	if startErr != nil {
		runLogger.Error("failed to create resumed execution session", "error", startErr)
		_ = h.runRepo.UpdateStatus(prepareCtx, runID, string(model.RunStatusFailed), "failed to create execution session")
		writeError(w, http.StatusInternalServerError, "Failed to start resumed run")
		return
	}
	if !started {
		writeError(w, http.StatusConflict, "Run already has an active execution")
		return
	}
	// Close the durable-resume/register race with cancellation. A cancellation
	// that won before registration is reflected in the repository; later ones
	// can signal the now-visible session directly through the registry.
	latest, latestErr := h.runRepo.GetRunForUser(prepareCtx, runID, userID)
	if latestErr != nil {
		h.executions.Cancel(runID)
		runLogger.Error("failed to fence resumed execution against cancellation", "error", latestErr)
		writeError(w, http.StatusInternalServerError, "Failed to verify resumed run")
		return
	}
	if latest.Status == string(model.RunStatusCancelling) || latest.Status == string(model.RunStatusCancelled) {
		h.executions.Cancel(runID)
	}

	writeSSEHeaders(w)
	subscription, exists := h.executions.Subscribe(runID, resumeAfterSeq)
	if !exists {
		return
	}
	serveSubscription(r.Context(), w, flusher, subscription)
}

func (h *RunHandler) executeResumedRun(
	runCtx context.Context,
	publish func(agent.StreamEvent),
	dispatchReq dispatcher.DispatchRequest,
	snapshot *agent.RunSnapshot,
	userID string,
	attempt int,
	logger *slog.Logger,
) {
	events := make(chan agent.StreamEvent, 128)
	done := make(chan runOutcome, 1)
	go func() {
		var result *agent.RunResult
		var runErr error
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("panic in RunStream", "error", recovered)
				runErr = fmt.Errorf("panic in stream execution: %v", recovered)
			}
			done <- runOutcome{result, runErr}
		}()
		result, runErr = h.dispatcher.Dispatch(runCtx, dispatchReq, events)
	}()

	stream := collectRunExecution(events, done, publish, logger)
	if stream.out.res != nil {
		if len(stream.out.res.NewMessages) == 0 {
			publish(agent.StreamEvent{Type: agent.EventRunPersisted, Time: time.Now()})
		} else {
			persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancelPersist()
			savedDocs, insertErr := h.messageRepo.InsertMany(
				persistCtx,
				snapshot.Meta.ThreadID,
				snapshot.Meta.AgentID,
				userID,
				withRunMetadata(stream.out.res.NewMessages, dispatchReq.RunID, attempt),
			)
			if insertErr != nil {
				logger.Error("message persist failed", "attempt", attempt, "thread_id", snapshot.Meta.ThreadID, "error", insertErr)
				publish(agent.StreamEvent{
					Type:  agent.EventRunPersistFail,
					Time:  time.Now(),
					Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
				})
			} else {
				logger.Info("messages persisted", "attempt", attempt, "steps", stream.out.res.Steps, "thread_id", snapshot.Meta.ThreadID, "messages", len(savedDocs))
				publish(agent.StreamEvent{Type: agent.EventRunPersisted, Time: time.Now()})
			}
		}
	}
	if stream.terminalEvent != nil {
		publish(*stream.terminalEvent)
	}
}

func (h *RunHandler) resourceKind(ctx context.Context, resourceID, userID string) agent.ResourceKind {
	resource, err := h.agentRepo.GetByID(ctx, resourceID, userID)
	if err != nil {
		return ""
	}
	return agent.EffectiveResourceKind(resource)
}
