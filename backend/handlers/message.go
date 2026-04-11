package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"backend/agent"
	"backend/llm"
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

	result, err := h.runtime.Run(ctx, ag, agent.RunContext{
		Summary: currentSummary,
		History: history,
		Input:   req.Content,
	})
	if err != nil {
		switch err {
		case agent.ErrMaxStepsReached:
			writeError(w, http.StatusUnprocessableEntity, "agent exceeded maximum steps")
		case agent.ErrNoFinalOutput:
			writeError(w, http.StatusUnprocessableEntity, "agent did not produce a response")
		case agent.ErrToolNotAvailable:
			writeError(w, http.StatusUnprocessableEntity, "agent requested an unavailable tool")
		default:
			log.Printf("[message] runtime error thread=%s err=%v", threadID, err)
			writeError(w, http.StatusInternalServerError, "agent execution failed")
		}
		return
	}

	if err := h.messageRepo.InsertMany(ctx, threadID, thread.AgentID.Hex(), userID, result.NewMessages); err != nil {
		log.Printf("[message] persist failed thread=%s err=%v", threadID, err)
		writeError(w, http.StatusInternalServerError, "failed to save messages")
		return
	}

	totalUsage := llm.TokenUsage{
		PromptTokens:     summarizeUsage.PromptTokens + result.Usage.PromptTokens,
		CompletionTokens: summarizeUsage.CompletionTokens + result.Usage.CompletionTokens,
		TotalTokens:      summarizeUsage.TotalTokens + result.Usage.TotalTokens,
	}

	msgs := make([]MessageResponse, len(result.NewMessages))
	for i, m := range result.NewMessages {
		msgs[i] = MessageResponse{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
		}
	}

	writeJSON(w, http.StatusOK, SendMessageResponse{
		Messages: msgs,
		Steps:    result.Steps,
		Usage:    totalUsage,
	})
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
	messages, err := h.messageRepo.ListRecentByThread(r.Context(), threadID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load messages")
		return
	}

	resp := make([]MessageResponse, len(messages))
	for i, m := range messages {
		resp[i] = MessageResponse{
			Role:    m.Role,
			Content: m.Content,
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
