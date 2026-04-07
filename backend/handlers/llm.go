package handlers

import (
	"backend/llm"
	"backend/model"
	"context"
	"encoding/json"
	"log"
	"net/http"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type LLMHandler struct {
	LLMRegistry *mongo.Collection
	Registry    *llm.Registry
}

func (lh *LLMHandler) GetLLMs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	cursor, err := lh.LLMRegistry.Find(context.TODO(), bson.M{})
	if err != nil {
		http.Error(w, "Internal Server Error while fetching models", http.StatusInternalServerError)
		return
	}
	defer cursor.Close(context.TODO())

	var models []model.LLMModel

	if err := cursor.All(context.TODO(), &models); err != nil {
		http.Error(w, "Error processing model data", http.StatusInternalServerError)
		return
	}

	if models == nil {
		models = []model.LLMModel{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

// ── Chat Test Endpoint ────────────────────────────────────

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
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
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

	if req.Provider == "" || req.Model == "" || len(req.Messages) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: "provider, model, and messages are required"})
		return
	}

	client, err := lh.Registry.Get(req.Provider)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(chatErrorResponse{Error: err.Error()})
		return
	}

	messages := make([]llm.ChatMessage, len(req.Messages))
	for i, m := range req.Messages {
		messages[i] = llm.ChatMessage{
			Role:    m.Role,
			Content: m.Content,
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
		Content:   resp.Content,
		ToolCalls: resp.ToolCalls,
		Model:     resp.Model,
		Usage:     resp.Usage,
	})
}
