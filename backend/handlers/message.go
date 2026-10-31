package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"backend/agent"
	"backend/dispatcher"
	"backend/llm"
	"backend/model"
	"backend/pagination"

	"github.com/google/uuid"
)

// messageStore is the subset of mongorepo.MessageRepo used by MessageHandler.
type messageStore interface {
	ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error)
	InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]agent.MessageRecord, error)
	ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error)
	InsertUserPrompt(ctx context.Context, threadID, agentID, userID, runID, content string) (agent.MessageRecord, bool, error)
}

type messagePageStore interface {
	ListDocsByThreadPage(ctx context.Context, threadID string, request pagination.Request) (pagination.Page[agent.MessageRecord], error)
}

type topLevelRunStore interface {
	AdmitTopLevelRun(ctx context.Context, in agent.RunAdmission) (agent.RunAdmissionResult, error)
	MarkPromptPersisted(ctx context.Context, runID string) error
	ClaimRunDispatch(ctx context.Context, runID string) (bool, error)
}

type MessageHandler struct {
	agentRepo   agentReader
	threadRepo  threadStore
	messageRepo messageStore
	dispatcher  dispatcher.Dispatcher
	runRepo     agent.CheckpointStore
	executions  *ExecutionRegistry
}

func NewMessageHandler(
	agentRepo agentReader,
	threadRepo threadStore,
	messageRepo messageStore,
	disp dispatcher.Dispatcher,
	runRepo agent.CheckpointStore,
	registries ...*ExecutionRegistry,
) *MessageHandler {
	executions := NewExecutionRegistry()
	if len(registries) > 0 && registries[0] != nil {
		executions = registries[0]
	}
	return &MessageHandler{
		agentRepo:   agentRepo,
		threadRepo:  threadRepo,
		messageRepo: messageRepo,
		dispatcher:  disp,
		runRepo:     runRepo,
		executions:  executions,
	}
}

type SendMessageRequest struct {
	Content string `json:"content"`
}

type MessageResponse struct {
	ID         string         `json:"id"`
	RunID      string         `json:"run_id,omitempty"`
	Attempt    int            `json:"attempt,omitempty"`
	Role       string         `json:"role"`
	Content    string         `json:"content"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	ToolCalls  []llm.ToolCall `json:"tool_calls,omitempty"`
	ToolName   string         `json:"tool_name,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	CreatedAt  string         `json:"created_at"`
}

type SendMessageResponse struct {
	Messages []MessageResponse `json:"messages"`
	Steps    int               `json:"steps"`
	Usage    llm.TokenUsage    `json:"usage"`
}

func (h *MessageHandler) Send(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	threadID := r.PathValue("id")

	var req SendMessageRequest

	if !decodeJSON(w, r, &req) {
		return
	}

	if strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	submissionKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if submissionKey == "" {
		writeError(w, http.StatusBadRequest, "Idempotency-Key header is required")
		return
	}
	if len(submissionKey) > 200 {
		writeError(w, http.StatusBadRequest, "Idempotency-Key header is too long")
		return
	}

	ctx := r.Context()

	thread, err := h.threadRepo.GetByID(ctx, threadID, userID)
	if err != nil {
		if err.Error() == "thread not found" {
			writeError(w, http.StatusNotFound, "thread not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load thread")
		return
	}

	ag, err := h.agentRepo.GetByID(ctx, thread.AgentID, userID)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent")
		return
	}
	teamID := ""
	if agent.EffectiveResourceKind(ag) == agent.ResourceKindAgentTeam {
		teamID = ag.ID
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
	}

	admissions, ok := h.runRepo.(topLevelRunStore)
	if !ok {
		writeError(w, http.StatusInternalServerError, "run admission is unavailable")
		return
	}
	admission, err := admissions.AdmitTopLevelRun(ctx, agent.RunAdmission{
		RunID: uuid.NewString(), ThreadID: threadID, AgentID: ag.ID, UserID: userID,
		TeamID:        teamID,
		SubmissionKey: submissionKey, AcceptedInput: req.Content,
	})
	if err != nil {
		switch {
		case errors.Is(err, agent.ErrSubmissionKeyConflict):
			writeError(w, http.StatusConflict, "Idempotency-Key was already used with different content")
		case errors.Is(err, agent.ErrThreadRunActive):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "thread already has an active run", "active_run_id": admission.ActiveRun})
		default:
			slog.Error("failed to admit run", "thread_id", threadID, "user_id", userID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to initialize run")
		}
		return
	}
	// Admission created the durable run boundary. Everything after this point
	// must complete independently of the browser request so a disconnect cannot
	// strand a prompt or a claimed dispatch halfway through orchestration.
	admittedCtx := context.WithoutCancel(ctx)
	runID := admission.Run.RunID
	runLogger := slog.With("run_id", runID, "thread_id", threadID, "user_id", userID)
	if _, _, err := h.messageRepo.InsertUserPrompt(admittedCtx, threadID, ag.ID, userID, runID, admission.Run.AcceptedInput); err != nil {
		runLogger.Error("failed to persist accepted prompt", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to persist accepted prompt")
		return
	}
	if err := admissions.MarkPromptPersisted(admittedCtx, runID); err != nil {
		runLogger.Error("failed to mark accepted prompt persisted", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to persist accepted prompt")
		return
	}
	if activity, ok := h.threadRepo.(threadActivityStore); ok {
		if err := activity.Touch(admittedCtx, threadID, userID); err != nil {
			runLogger.Error("failed to update thread activity", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to update thread activity")
			return
		}
	}
	dispatchClaimed, err := admissions.ClaimRunDispatch(admittedCtx, runID)
	if err != nil {
		runLogger.Error("failed to claim run dispatch", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to start run")
		return
	}
	acceptedStatus := admission.Run.Status
	if dispatchClaimed {
		current, getErr := h.runRepo.GetRun(admittedCtx, runID)
		if getErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to verify run dispatch")
			return
		}
		acceptedStatus = current.Status
		attempt := admission.Run.Attempt
		if attempt <= 0 {
			attempt = 1
		}
		started, startErr := h.executions.Start(runID, func(runCtx context.Context, publish func(agent.StreamEvent)) {
			h.executeMessageRun(runCtx, publish, dispatcher.DispatchRequest{
				RunID:    runID,
				AgentID:  ag.ID,
				TeamID:   teamID,
				UserID:   userID,
				ThreadID: threadID,
				Input:    admission.Run.AcceptedInput,
				Attempt:  attempt,
				Logger:   runLogger,
			}, thread.AgentID, userID, attempt, runLogger)
		})
		if startErr != nil {
			runLogger.Error("failed to create execution session", "error", startErr)
			writeError(w, http.StatusInternalServerError, "failed to start run")
			return
		}
		if !started {
			runLogger.Warn("run dispatch was claimed but an execution session already exists")
		}
		// Close the claim/register race with cancellation. Once the session is
		// visible, a fresh durable read tells us whether a cancel request won in
		// the gap; later cancel requests can signal this registered session.
		latest, latestErr := h.runRepo.GetRun(admittedCtx, runID)
		if latestErr != nil {
			h.executions.Cancel(runID)
			runLogger.Error("failed to fence execution against cancellation", "error", latestErr)
			writeError(w, http.StatusInternalServerError, "failed to verify run dispatch")
			return
		}
		if latest.Status == string(model.RunStatusCancelling) || latest.Status == string(model.RunStatusCancelled) {
			h.executions.Cancel(runID)
		}
	}

	acceptedAgentID := ag.ID
	acceptedAgentName := ag.Name
	if teamID != "" {
		// Admission knows the Team resource, but the preparer resolves its entry
		// Agent later. Do not mislabel the Team ID as the executing Agent.
		acceptedAgentID = ""
		acceptedAgentName = ""
	}
	writeSSEHeaders(w)
	if err := emitEvent(w, flusher, agent.StreamEvent{
		ID:               runID + "-0",
		RunID:            runID,
		OriginatorRunID:  runID,
		TeamID:           teamID,
		AgentID:          acceptedAgentID,
		AgentName:        acceptedAgentName,
		InvocationKind:   agent.InvocationTopLevel,
		Seq:              0,
		Type:             agent.EventRunAccepted,
		Time:             time.Now(),
		Attempt:          admission.Run.Attempt,
		Status:           acceptedStatus,
		Replayed:         admission.Replayed,
		StreamID:         runID + ":0",
		StreamSeq:        0,
		DeliveryReplayed: admission.Replayed,
	}); err != nil {
		// The execution, if newly claimed, is already runtime-owned. A failed
		// first write therefore detaches this request without cancelling it.
		return
	}
	subscription, exists := h.executions.Subscribe(runID, 0)
	if !exists {
		return
	}
	serveSubscription(r.Context(), w, flusher, subscription)
}

func (h *MessageHandler) executeMessageRun(
	runCtx context.Context,
	publish func(agent.StreamEvent),
	dispatchReq dispatcher.DispatchRequest,
	resourceID string,
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
	allMessages := []llm.ChatMessage{}
	if stream.out.res != nil {
		allMessages = append(allMessages, stream.out.res.NewMessages...)
	}
	allMessages = withRunMetadata(allMessages, dispatchReq.RunID, attempt)

	persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelPersist()
	docs, err := h.messageRepo.InsertMany(
		persistCtx,
		dispatchReq.ThreadID,
		resourceID,
		userID,
		allMessages,
	)
	if err != nil {
		logger.Error("message persist failed", "error", err)
		publish(agent.StreamEvent{
			Type:  agent.EventRunPersistFail,
			Time:  time.Now(),
			Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
		})
	} else {
		logger.Info("messages persisted", "count", len(docs))
		publish(agent.StreamEvent{Type: agent.EventRunPersisted, Time: time.Now()})
	}
	if stream.terminalEvent != nil {
		publish(*stream.terminalEvent)
	}
}

type pendingPromptRunStore interface {
	ListPendingAcceptedPrompts(ctx context.Context, userID string) ([]*agent.RunInfo, error)
	MarkPromptPersisted(ctx context.Context, runID string) error
}

func ReconcileAcceptedPrompts(ctx context.Context, userID string, runs pendingPromptRunStore, messages messageStore) (int, error) {
	pending, err := runs.ListPendingAcceptedPrompts(ctx, userID)
	if err != nil {
		return 0, err
	}
	for _, run := range pending {
		if _, _, err := messages.InsertUserPrompt(ctx, run.ThreadID, run.AgentID, run.UserID, run.RunID, run.AcceptedInput); err != nil {
			return 0, fmt.Errorf("reconcile prompt for run %s: %w", run.RunID, err)
		}
		if err := runs.MarkPromptPersisted(ctx, run.RunID); err != nil {
			return 0, fmt.Errorf("mark reconciled prompt for run %s: %w", run.RunID, err)
		}
	}
	return len(pending), nil
}

func toMessageResponse(doc agent.MessageRecord) MessageResponse {
	return MessageResponse{
		ID:         doc.ID,
		RunID:      metadataString(doc.Metadata, "run_id"),
		Attempt:    metadataInt(doc.Metadata, "attempt"),
		Role:       doc.Role,
		Content:    doc.Content,
		ToolCallID: doc.ToolCallID,
		ToolCalls:  doc.ToolCalls,
		ToolName:   doc.ToolName,
		Metadata:   doc.Metadata,
		CreatedAt:  doc.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func withRunMetadata(messages []llm.ChatMessage, runID string, attempt int) []llm.ChatMessage {
	decorated := make([]llm.ChatMessage, len(messages))
	for i, message := range messages {
		decorated[i] = message
		metadata := make(map[string]any, len(message.Metadata)+2)
		for key, value := range message.Metadata {
			metadata[key] = value
		}
		metadata["run_id"] = runID
		metadata["attempt"] = attempt
		decorated[i].Metadata = metadata
	}
	return decorated
}

func metadataString(metadata map[string]any, key string) string {
	value, _ := metadata[key].(string)
	return value
}

func metadataInt(metadata map[string]any, key string) int {
	switch value := metadata[key].(type) {
	case int:
		return value
	case int32:
		return int(value)
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	threadID := r.PathValue("id")

	if _, err := h.threadRepo.GetByID(r.Context(), threadID, userID); err != nil {
		if err.Error() == "thread not found" {
			writeError(w, http.StatusNotFound, "thread not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify thread access")
		return
	}

	request, ok := parsePage(w, r, "messages", 50)
	if !ok {
		return
	}
	pages, ok := h.messageRepo.(messagePageStore)
	if !ok {
		writeError(w, http.StatusInternalServerError, "message pagination is unavailable")
		return
	}
	page, err := pages.ListDocsByThreadPage(r.Context(), threadID, request)
	if err != nil {
		if errors.Is(err, pagination.ErrInvalidCursor) {
			writeError(w, http.StatusBadRequest, "invalid cursor")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load messages")
		return
	}

	resp := make([]MessageResponse, len(page.Items))
	for i, m := range page.Items {
		resp[i] = toMessageResponse(m)
	}
	response, err := pageResponse(resp, page.Next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode message page")
		return
	}
	writeJSON(w, http.StatusOK, response)
}
