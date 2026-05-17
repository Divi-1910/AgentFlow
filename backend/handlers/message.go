package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/model"
	"backend/runtimectx"

	"github.com/google/uuid"
)

// messageStore is the subset of repository.MessageRepo used by MessageHandler.
type messageStore interface {
	ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error)
	InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]model.MessageDocument, error)
	ListDocsByThread(ctx context.Context, threadID string, limit int) ([]model.MessageDocument, error)
}

// runtimeExecutor is the subset of agent.AgentRuntime used by MessageHandler.
type runtimeExecutor interface {
	RunStream(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error)
}

// summarizeExecutor is the subset of agent.Summarizer used by MessageHandler.
type summarizeExecutor interface {
	Summarize(ctx context.Context, ag *agent.Agent, existingSummary string, turns []agent.Turn) (string, llm.TokenUsage, error)
}

type MessageHandler struct {
	agentRepo   agentStore
	threadRepo  threadStore
	messageRepo messageStore
	runtime     runtimeExecutor
	summarizer  summarizeExecutor
	runRepo     agent.CheckpointStore
	background  context.Context
	summarizing sync.Map
}

func NewMessageHandler(
	agentRepo agentStore,
	threadRepo threadStore,
	messageRepo messageStore,
	runtime runtimeExecutor,
	summarizer summarizeExecutor,
	runRepo agent.CheckpointStore,
	background context.Context,
) *MessageHandler {
	if background == nil {
		background = context.Background()
	}
	return &MessageHandler{
		agentRepo:   agentRepo,
		threadRepo:  threadRepo,
		messageRepo: messageRepo,
		runtime:     runtime,
		summarizer:  summarizer,
		runRepo:     runRepo,
		background:  background,
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

	ag, err := h.agentRepo.GetByID(ctx, thread.AgentID.Hex(), userID)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent")
		return
	}

	rawMessages, err := h.messageRepo.ListRecentByThread(ctx, threadID, 500)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load history")
		return
	}

	turns := agent.GroupIntoTurns(rawMessages)

	currentSummary := thread.Summary

	if agent.ShouldSummarize(ag, currentSummary, turns) {
		drop, keep := agent.SplitTurnsForCompaction(ag, currentSummary, turns)

		if len(drop) > 0 {
			turns = keep

			bgLogger := slog.With("thread_id", threadID)
			if _, alreadyRunning := h.summarizing.LoadOrStore(threadID, struct{}{}); !alreadyRunning {
				go func(ctx context.Context, ag *agent.Agent, summary string, drop []agent.Turn) {
					defer h.summarizing.Delete(threadID)
					defer func() {
						if rec := recover(); rec != nil {
							bgLogger.Error("bg summarization panic", "error", rec)
						}
					}()

					compactCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
					defer cancel()

					newSummary, _, err := h.summarizer.Summarize(compactCtx, ag, summary, drop)
					if err != nil {
						bgLogger.Error("bg summarization failed", "error", err)
					} else {
						if updateErr := h.threadRepo.UpdateSummary(compactCtx, threadID, userID, newSummary); updateErr != nil {
							bgLogger.Error("bg summarization persist failed", "error", updateErr)
						}
					}
				}(h.background, ag, currentSummary, drop)
			} else {
				bgLogger.Info("bg summarization skipped, already in flight")
			}
		}
	}

	history := agent.FlattenTurns(turns)

	runID := uuid.NewString()
	runLogger := slog.With("run_id", runID, "thread_id", threadID, "user_id", userID)

	runCtx := agent.RunContext{
		RunID:    runID,
		ThreadID: threadID,
		Attempt:  1,
		Summary:  currentSummary,
		History:  history,
		Input:    req.Content,
		Memory: runtimectx.MemoryScope{
			UserID:   userID,
			AgentID:  ag.ID,
			ThreadID: threadID,
		},
		Logger: runLogger,
	}

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
	persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelPersist()

	if sr.clientDisconnected {
		if out.res != nil {
			allMessages := append([]llm.ChatMessage{{Role: "user", Content: req.Content}}, out.res.NewMessages...)
			_, _ = h.messageRepo.InsertMany(persistCtx, threadID, thread.AgentID.Hex(), userID, allMessages)
		}
		return
	}

	if out.res != nil {
		allMessages := append(
			[]llm.ChatMessage{{Role: "user", Content: req.Content}},
			out.res.NewMessages...,
		)
		docs, err := h.messageRepo.InsertMany(persistCtx, threadID, thread.AgentID.Hex(), userID, allMessages)
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

func toMessageResponse(doc model.MessageDocument) MessageResponse {
	return MessageResponse{
		ID:         doc.ID.Hex(),
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
