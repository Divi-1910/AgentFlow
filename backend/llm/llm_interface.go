package llm

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrRateLimited       = errors.New("Rate Limit Exceeded")
	ErrInvalidAPIKey     = errors.New("Invalid API Key")
	ErrBadRequest        = errors.New("Bad Request")
	ErrLLMTimeOut        = errors.New("LLM Time Out")
	ErrInternal          = errors.New("Internal Server Error")
	ErrStreamInterrupted = errors.New("LLM stream interrupted after visible output")
)

type LLMClient interface {
	ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
}

// TextDeltaHandler receives only assistant text that is safe to display to a
// user. Provider reasoning/thinking fields and partial tool arguments must
// never be passed to this callback.
type TextDeltaHandler func(delta string) error

// StreamingLLMClient is an optional capability implemented by providers that
// can expose incremental assistant text. The returned ChatResponse is still the
// authoritative, complete response used for tool execution, checkpoints, and
// persistence. Deltas are an ephemeral progress projection only.
type StreamingLLMClient interface {
	LLMClient
	ChatCompletionStream(ctx context.Context, req *ChatRequest, onTextDelta TextDeltaHandler) (*ChatResponse, error)
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
	Metadata   map[string]any
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
	// Instructions are usage hints for the model (e.g. "always set expiry").
	// They are injected into the system prompt by the ContextBuilder, not sent
	// to the LLM as part of the tool schema, hence json:"-".
	Instructions string `json:"-"`
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
