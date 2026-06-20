package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"backend/agent"
	"backend/dispatcher"
	"backend/llm"

	"github.com/google/uuid"
)

// messageStore is the subset of repository.MessageRepo used by MessageHandler.
type messageStore interface {
	ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error)
	InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]agent.MessageRecord, error)
	ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error)
}

type MessageHandler struct {
	agentRepo   agentReader
	threadRepo  threadStore
	messageRepo messageStore
	dispatcher  dispatcher.Dispatcher
	runRepo     agent.CheckpointStore
}

func NewMessageHandler(
	agentRepo agentReader,
	threadRepo threadStore,
	messageRepo messageStore,
	disp dispatcher.Dispatcher,
	runRepo agent.CheckpointStore,
) *MessageHandler {
	return &MessageHandler{
		agentRepo:   agentRepo,
		threadRepo:  threadRepo,
		messageRepo: messageRepo,
		dispatcher:  disp,
		runRepo:     runRepo,
	}
}

type SendMessageRequest struct {
	Content string `json:"content"`
}

type MessageResponse struct {
	ID         string         `json:"id"`
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

	if _, err := h.messageRepo.ListRecentByThread(ctx, threadID, 500); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load history")
		return
	}

	runID := uuid.NewString()
	runLogger := slog.With("run_id", runID, "thread_id", threadID, "user_id", userID)

	if h.runRepo != nil {
		if err := h.runRepo.CreateRun(r.Context(), runID, threadID, ag.ID, userID); err != nil {
			runLogger.Error("failed to create run document", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to initialize run")
			return
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	runCtxStream, cancelStream := context.WithCancel(r.Context())
	defer cancelStream()

	events := make(chan agent.StreamEvent, 128)
	done := make(chan runOutcome, 1)
	dispatchReq := dispatcher.DispatchRequest{
		RunID:    runID,
		AgentID:  ag.ID,
		UserID:   userID,
		ThreadID: threadID,
		Input:    req.Content,
		Attempt:  1,
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
	persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelPersist()

	if sr.clientDisconnected {
		if out.res != nil {
			allMessages := append([]llm.ChatMessage{{Role: "user", Content: req.Content}}, out.res.NewMessages...)
			_, _ = h.messageRepo.InsertMany(persistCtx, threadID, thread.AgentID, userID, allMessages)
		}
		return
	}

	if out.res != nil {
		allMessages := append(
			[]llm.ChatMessage{{Role: "user", Content: req.Content}},
			out.res.NewMessages...,
		)
		docs, err := h.messageRepo.InsertMany(persistCtx, threadID, thread.AgentID, userID, allMessages)
		if err != nil {
			runLogger.Error("message persist failed", "error", err)
			emitEvent(w, flusher, agent.StreamEvent{
				Type:  agent.EventRunPersistFail,
				Time:  time.Now(),
				Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
			})
		} else {
			runLogger.Info("messages persisted", "count", len(docs))
			emitEvent(w, flusher, agent.StreamEvent{Type: agent.EventRunPersisted, Time: time.Now()})
		}
	}

	if sr.terminalEvent != nil {
		emitEvent(w, flusher, *sr.terminalEvent)
	}
}

func toMessageResponse(doc agent.MessageRecord) MessageResponse {
	return MessageResponse{
		ID:         doc.ID,
		Role:       doc.Role,
		Content:    doc.Content,
		ToolCallID: doc.ToolCallID,
		ToolCalls:  doc.ToolCalls,
		ToolName:   doc.ToolName,
		Metadata:   doc.Metadata,
		CreatedAt:  doc.CreatedAt.UTC().Format(time.RFC3339Nano),
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

	limit := parseLimit(r, 50, 500)
	messages, err := h.messageRepo.ListDocsByThread(r.Context(), threadID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load messages")
		return
	}

	resp := make([]MessageResponse, len(messages))
	for i, m := range messages {
		resp[i] = toMessageResponse(m)
	}
	writeJSON(w, http.StatusOK, resp)
}
