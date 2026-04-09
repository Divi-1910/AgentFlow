package llm

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrRateLimited   = errors.New("Rate Limit Exceeded")
	ErrInvalidAPIKey = errors.New("Invalid API Key")
	ErrBadRequest    = errors.New("Bad Request")
	ErrLLMTimeOut    = errors.New("LLM Time Out")
	ErrInternal      = errors.New("Internal Server Error")
)

type LLMClient interface {
	ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
}

type ChatRequest struct {
	Model       string
	Messages    []ChatMessage
	Tools       []ToolDefinition
	Temperature float64
	MaxTokens   int
	Params      map[string]any
}

type ChatMessage struct {
	Role       string
	Content    string
	ToolCallID string
	ToolCalls  []ToolCall
}

type ChatResponse struct {
	Content   string
	ToolCalls []ToolCall
	Model     string
	Usage     TokenUsage
}

type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type TokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type AdapterConfig struct {
	APIKey     string
	BaseURL    string
	MaxRetries int
	Timeout    time.Duration
}
