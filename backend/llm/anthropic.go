package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"time"
)

const (
	anthropicDefaultMaxTokens = 8192
	anthropicAPIVersion       = "2023-06-01"
)

type AnthropicAdapter struct {
	apiKey     string
	client     *http.Client
	maxRetries int
}

func NewAnthropicAdapter(config AdapterConfig) *AnthropicAdapter {
	return &AnthropicAdapter{
		apiKey: config.APIKey,
		client: &http.Client{
			Timeout: config.Timeout,
		},
		maxRetries: config.MaxRetries,
	}
}

type anthropicRequest struct {
	Model       string             `json:"model"`
	System      string             `json:"system,omitempty"`
	Messages    []anthropicMessage `json:"messages"`
	Tools       []anthropicTool    `json:"tools,omitempty"`
	MaxTokens   int                `json:"max_tokens"`
	Temperature float64            `json:"temperature,omitempty"`
}

type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthropicContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   string          `json:"content,omitempty"`
}
type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}
type anthropicResponse struct {
	ID         string                  `json:"id"`
	Model      string                  `json:"model"`
	Content    []anthropicContentBlock `json:"content"`
	Usage      anthropicUsage          `json:"usage"`
	StopReason string                  `json:"stop_reason"`
}

type anthropicUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}
type anthropicErrorResponse struct {
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func (a *AnthropicAdapter) ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	payload := a.buildPayload(req)

	bodyBytes, err := json.Marshal(payload)

	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	var lastErr error

	for attempt := 0; attempt <= a.maxRetries; attempt++ {

		if attempt > 0 {

			backoff := time.Duration(math.Pow(2, float64(attempt-1))) * time.Second

			log.Printf("Anthropic retry %d/%d after %v", attempt, a.maxRetries, backoff)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))

		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		httpReq.Header.Set("Content-Type", "application/json")

		httpReq.Header.Set("x-api-key", a.apiKey)

		httpReq.Header.Set("anthropic-version", anthropicAPIVersion)

		resp, err := a.client.Do(httpReq)

		if err != nil {
			lastErr = fmt.Errorf("request failed: %w", err)
			continue
		}

		respBody, err := io.ReadAll(resp.Body)

		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to read response: %w", err)
			continue
		}

		if resp.StatusCode != http.StatusOK {
			lastErr = a.handleErrorStatus(resp.StatusCode, respBody)
			if resp.StatusCode == 429 || resp.StatusCode >= 500 {
				continue
			}
			return nil, lastErr
		}

		return a.parseResponse(respBody)
	}

	return nil, fmt.Errorf("exhausted retries: %w", lastErr)
}

func (a *AnthropicAdapter) buildPayload(req *ChatRequest) map[string]interface{} {
	var system string
	var messages []ChatMessage
	for _, m := range req.Messages {
		if m.Role == "system" {
			system = m.Content
		} else {
			messages = append(messages, m)
		}
	}

	anthMessages := make([]anthropicMessage, 0, len(messages))
	for _, m := range messages {
		switch {
		case m.Role == "tool":
			block := anthropicContentBlock{
				Type:      "tool_result",
				ToolUseID: m.ToolCallID,
				Content:   m.Content,
			}
			blockJSON, _ := json.Marshal([]anthropicContentBlock{block})
			anthMessages = append(anthMessages, anthropicMessage{
				Role:    "user",
				Content: blockJSON,
			})
		case m.Role == "assistant" && len(m.ToolCalls) > 0:
			blocks := make([]anthropicContentBlock, 0)
			if m.Content != "" {
				blocks = append(blocks, anthropicContentBlock{
					Type: "text",
					Text: m.Content,
				})
			}
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, anthropicContentBlock{
					Type:  "tool_use",
					ID:    tc.ID,
					Name:  tc.Name,
					Input: tc.Arguments,
				})
			}
			blockJSON, _ := json.Marshal(blocks)
			anthMessages = append(anthMessages, anthropicMessage{
				Role:    "assistant",
				Content: blockJSON,
			})
		default:
			contentJSON, _ := json.Marshal(m.Content)
			anthMessages = append(anthMessages, anthropicMessage{
				Role:    m.Role,
				Content: contentJSON,
			})
		}
	}

	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = anthropicDefaultMaxTokens
	}

	payload := map[string]interface{}{
		"model":      req.Model,
		"messages":   anthMessages,
		"max_tokens": maxTokens,
	}

	if system != "" {
		payload["system"] = system
	}

	if req.Temperature > 0 {
		payload["temperature"] = req.Temperature
	}

	if len(req.Tools) > 0 {
		tools := make([]anthropicTool, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = anthropicTool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.Parameters,
			}
		}
		payload["tools"] = tools
	}

	for k, v := range req.Params {
		payload[k] = v
	}

	return payload
}

func (a *AnthropicAdapter) parseResponse(body []byte) (*ChatResponse, error) {
	var raw anthropicResponse

	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	resp := &ChatResponse{
		Model: raw.Model,
		Usage: TokenUsage{
			PromptTokens:     raw.Usage.InputTokens,
			CompletionTokens: raw.Usage.OutputTokens,
			TotalTokens:      raw.Usage.InputTokens + raw.Usage.OutputTokens,
		},
	}

	for _, block := range raw.Content {
		switch block.Type {
		case "text":
			resp.Content += block.Text
		case "tool_use":
			resp.ToolCalls = append(resp.ToolCalls, ToolCall{
				ID:        block.ID,
				Name:      block.Name,
				Arguments: block.Input,
			})
		}
	}

	return resp, nil
}

func (a *AnthropicAdapter) handleErrorStatus(status int, body []byte) error {
	var errResp anthropicErrorResponse

	json.Unmarshal(body, &errResp)

	msg := errResp.Error.Message

	if msg == "" {
		msg = string(body)
	}

	switch status {
	case 401:
		return fmt.Errorf("%w: %s", ErrInvalidAPIKey, msg)
	case 429:
		return fmt.Errorf("%w: %s", ErrRateLimited, msg)
	case 400:
		return fmt.Errorf("%w: %s", ErrBadRequest, msg)
	default:
		return fmt.Errorf("provider error (status %d): %s", status, msg)
	}

}
