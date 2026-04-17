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
)

type MessageHandler struct {
	agentRepo   *repository.AgentRepo
	threadRepo  *repository.ThreadRepo
	messageRepo *repository.MessageRepo
	runtime     *agent.AgentRuntime
	summarizer  *agent.Summarizer
}

func NewMessageHandler(
	agentRepo *repository.AgentRepo,
	threadRepo *repository.ThreadRepo,
	messageRepo *repository.MessageRepo,
	runtime *agent.AgentRuntime,
	summarizer *agent.Summarizer,
) *MessageHandler {
	return &MessageHandler{
		agentRepo:   agentRepo,
		threadRepo:  threadRepo,
		messageRepo: messageRepo,
		runtime:     runtime,
		summarizer:  summarizer,
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
	var summarizeUsage llm.TokenUsage

	if agent.ShouldSummarize(ag, currentSummary, turns) {
		drop, keep := agent.SplitTurnsForCompaction(ag, currentSummary, turns)

		if len(drop) > 0 {
			newSummary, usage, err := h.summarizer.Summarize(ctx, ag, currentSummary, drop)
			if err != nil {
				log.Printf("[message] summarization failed thread=%s err=%v — keeping full history", threadID, err)
			} else {
				if updateErr := h.threadRepo.UpdateSummary(ctx, threadID, userID, newSummary); updateErr != nil {
					log.Printf("[message] summary persist failed thread=%s err=%v — keeping full history", threadID, updateErr)
				} else {
					currentSummary = newSummary
					summarizeUsage = usage
					turns = keep
				}
			}
		}
	}

	history := agent.FlattenTurns(turns)

	runCtx := agent.RunContext{
		Summary: currentSummary,
		History: history,
		Input:   req.Content,
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
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
		res, err := h.runtime.RunStream(runCtxStream, ag, runCtx, events)
		done <- outcome{res, err}
	}()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	var terminalEvent *agent.StreamEvent
	clientDisconnected := false

loop:
	for {
		select {
		case <-runCtxStream.Done():
			// Either transport disconnected or we canceled it intentionally
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
				terminalEvent = &e
				continue
			}

			data, _ := json.Marshal(e)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				clientDisconnected = true
				cancelStream()
				break loop
			}
			flusher.Flush()
		}
	}

	// Wait safely for the goroutine to firmly exit
	out := <-done

	if clientDisconnected {
		// If client dropped early, still persist if anything returned, but don't bother trying to write the final event
		if out.res != nil {
			allMessages := append([]llm.ChatMessage{{Role: "user", Content: req.Content}}, out.res.NewMessages...)
			_, _ = h.messageRepo.InsertMany(ctx, threadID, thread.AgentID.Hex(), userID, allMessages)
		}
		return
	}

	// Flush the final terminal event BEFORE persistence events
	if terminalEvent != nil {
		if out.res != nil && terminalEvent.Usage != nil {
			terminalEvent.Usage.PromptTokens += summarizeUsage.PromptTokens
			terminalEvent.Usage.CompletionTokens += summarizeUsage.CompletionTokens
			terminalEvent.Usage.TotalTokens += summarizeUsage.TotalTokens
		}
		data, _ := json.Marshal(*terminalEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	if out.res != nil {
		allMessages := append(
			[]llm.ChatMessage{{Role: "user", Content: req.Content}},
			out.res.NewMessages...,
		)

		docs, err := h.messageRepo.InsertMany(ctx, threadID, thread.AgentID.Hex(), userID, allMessages)
		if err != nil {
			log.Printf("[message] persist failed thread=%s err=%v", threadID, err)
			streamEvent := agent.StreamEvent{
				Type:  agent.EventRunPersistFail,
				Time:  time.Now(),
				Error: &agent.ErrMeta{Code: "internal.persistence_error", Message: "Failed to persist messages"},
			}
			data, _ := json.Marshal(streamEvent)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		} else {
			_ = docs
			streamEvent := agent.StreamEvent{
				Type: agent.EventRunPersisted,
				Time: time.Now(),
			}
			data, _ := json.Marshal(streamEvent)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
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
