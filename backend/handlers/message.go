package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/model"
	"backend/repository"

	"github.com/google/uuid"
)

type MessageHandler struct {
	agentRepo   *repository.AgentRepo
	threadRepo  *repository.ThreadRepo
	messageRepo *repository.MessageRepo
	runtime     *agent.AgentRuntime
	summarizer  *agent.Summarizer
	runRepo     agent.CheckpointStore
	background  context.Context
}

func NewMessageHandler(
	agentRepo *repository.AgentRepo,
	threadRepo *repository.ThreadRepo,
	messageRepo *repository.MessageRepo,
	runtime *agent.AgentRuntime,
	summarizer *agent.Summarizer,
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
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
			go func(ctx context.Context, ag *agent.Agent, summary string, drop []agent.Turn) {
				defer func() {
					if rec := recover(); rec != nil {
						log.Printf("[message-bg-summary] panic recovered thread=%s rec=%v", threadID, rec)
					}
				}()

				compactCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()

				newSummary, _, err := h.summarizer.Summarize(compactCtx, ag, summary, drop)
				if err != nil {
					log.Printf("[message-bg-summary] summarization failed thread=%s err=%v", threadID, err)
				} else {
					if updateErr := h.threadRepo.UpdateSummary(compactCtx, threadID, userID, newSummary); updateErr != nil {
						log.Printf("[message-bg-summary] summary persist failed thread=%s err=%v", threadID, updateErr)
					}
				}
			}(h.background, ag, currentSummary, drop)

			turns = keep
		}
	}

	history := agent.FlattenTurns(turns)

	runID := uuid.NewString()

	runCtx := agent.RunContext{
		RunID:    runID,
		ThreadID: threadID,
		Attempt:  1,
		Summary:  currentSummary,
		History:  history,
		Input:    req.Content,
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

	if h.runRepo != nil {
		if err := h.runRepo.CreateRun(r.Context(), runID, threadID, ag.ID, userID); err != nil {
			log.Printf("[message-handler] failed to create run doc: %v", err)
			// Non-fatal, we can still run without checkpointing
		}
	}

	runCtxStream, cancelStream := context.WithCancel(r.Context())
	defer cancelStream()

	events := make(chan agent.StreamEvent, 128)

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
				log.Printf("[message] panic in RunStream: %v", rec)
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

			if e.Type == agent.EventRunCompleted || e.Type == agent.EventRunFailed || e.Type == agent.EventRunCancelled {
				if terminalEvent != nil {
					log.Printf("[message] WARN: duplicate terminal event emitted thread=%s type=%s", threadID, e.Type)
					continue
				}
				terminalEvent = &e
				continue
			}

			data, err := json.Marshal(e)
			if err != nil {
				log.Printf("[message] WARN: failed to marshal stream event type=%s err=%v", e.Type, err)
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				clientDisconnected = true
				cancelStream()
				break loop
			}
			flusher.Flush()
		}
	}

	out := <-done

	// Drain remaining events in case loop exited prematurely from canceled stream context
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

	// We MUST persist into a standalone context unbound to the user's connection status
	persistCtx, cancelPersist := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelPersist()

	if clientDisconnected {
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
			log.Printf("[message] persist failed thread=%s err=%v", threadID, err)
			streamEvent := agent.StreamEvent{
				Type:  agent.EventRunPersistFail,
				Time:  time.Now(),
				Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
			}
			data, _ := json.Marshal(streamEvent)
			fmt.Fprintf(w, "data: %s\n\n", data)
		} else {
			log.Printf("[message] persisted thread=%s messages=%d", threadID, len(docs))
			streamEvent := agent.StreamEvent{
				Type: agent.EventRunPersisted,
				Time: time.Now(),
			}
			data, _ := json.Marshal(streamEvent)
			fmt.Fprintf(w, "data: %s\n\n", data)
		}
		flusher.Flush()
	}

	if terminalEvent != nil {
		data, _ := json.Marshal(*terminalEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
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
