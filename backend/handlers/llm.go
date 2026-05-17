package handlers

import (
	"context"
	"net/http"

	"backend/llm"
	"backend/middleware"
	"backend/model"
)

// llmModelStore retrieves available LLM model definitions.
type llmModelStore interface {
	ListAll(ctx context.Context) ([]model.LLMModel, error)
}

// llmClientRegistry resolves a registered LLM client by provider name.
type llmClientRegistry interface {
	Get(provider string) (llm.LLMClient, error)
}

type LLMHandler struct {
	modelStore llmModelStore
	registry   llmClientRegistry
}

func NewLLMHandler(modelStore llmModelStore, registry llmClientRegistry) *LLMHandler {
	return &LLMHandler{modelStore: modelStore, registry: registry}
}

func (lh *LLMHandler) GetLLMs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	models, err := lh.modelStore.ListAll(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch models")
		return
	}

	writeJSON(w, http.StatusOK, models)
}

type chatRequest struct {
	Provider    string                 `json:"provider"`
	Model       string                 `json:"model"`
	Messages    []chatMessage          `json:"messages"`
	Tools       []llm.ToolDefinition   `json:"tools,omitempty"`
	Temperature float64                `json:"temperature,omitempty"`
	MaxTokens   int                    `json:"max_tokens,omitempty"`
	Params      map[string]interface{} `json:"params,omitempty"`
}

type chatMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	ToolCalls  []llm.ToolCall `json:"tool_calls,omitempty"`
}

type chatResponse struct {
	Provider  string         `json:"provider"`
	Content   string         `json:"content"`
	ToolCalls []llm.ToolCall `json:"tool_calls,omitempty"`
	Model     string         `json:"model"`
	Usage     llm.TokenUsage `json:"usage"`
}

func (lh *LLMHandler) Chat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	logger := middleware.LoggerFromContext(r.Context())

	var req chatRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.Provider == "" {
		writeError(w, http.StatusBadRequest, "provider is required")
		return
	}
	if req.Model == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	if len(req.Messages) == 0 {
		writeError(w, http.StatusBadRequest, "messages cannot be empty")
		return
	}

	client, err := lh.registry.Get(req.Provider)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	messages := make([]llm.ChatMessage, len(req.Messages))
	for i, m := range req.Messages {
		messages[i] = llm.ChatMessage{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
			ToolCalls:  m.ToolCalls,
		}
	}

	chatReq := &llm.ChatRequest{
		Model:       req.Model,
		Messages:    messages,
		Tools:       req.Tools,
		Temperature: req.Temperature,
		MaxTokens:   req.MaxTokens,
		Params:      req.Params,
	}

	logger.Info("chat: request", "provider", req.Provider, "model", req.Model, "messages", len(req.Messages))

	resp, err := client.ChatCompletion(r.Context(), chatReq)
	if err != nil {
		logger.Error("chat: provider error", "provider", req.Provider, "model", req.Model, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	logger.Info("chat: success", "model", resp.Model,
		"prompt_tokens", resp.Usage.PromptTokens,
		"completion_tokens", resp.Usage.CompletionTokens)

	writeJSON(w, http.StatusOK, chatResponse{
		Provider:  req.Provider,
		Content:   resp.Content,
		ToolCalls: resp.ToolCalls,
		Model:     resp.Model,
		Usage:     resp.Usage,
	})
}
