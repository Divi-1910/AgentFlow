package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"backend/llm"
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
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	models, err := lh.modelStore.ListAll(r.Context())
	if err != nil {
		http.Error(w, "Internal Server Error while fetching models", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
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

type chatErrorResponse struct {
	Error string `json:"error"`
}

func (lh *LLMHandler) Chat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: "invalid request body: " + err.Error()})
		return
	}

	if req.Provider == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: "provider is required"})
		return
	}

	if req.Model == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: "model is required"})
		return
	}

	if len(req.Messages) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: "messages cannot be empty"})
		return
	}

	client, err := lh.registry.Get(req.Provider)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: err.Error()})
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

	log.Printf("[chat] provider=%s model=%s messages=%d", req.Provider, req.Model, len(req.Messages))

	resp, err := client.ChatCompletion(r.Context(), chatReq)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: err.Error()})
		return
	}

	log.Printf("[chat] success model=%s prompt_tokens=%d completion_tokens=%d",
		resp.Model, resp.Usage.PromptTokens, resp.Usage.CompletionTokens)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(chatResponse{
		Provider:  req.Provider,
		Content:   resp.Content,
		ToolCalls: resp.ToolCalls,
		Model:     resp.Model,
		Usage:     resp.Usage,
	})
}
