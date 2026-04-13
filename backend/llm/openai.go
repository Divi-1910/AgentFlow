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
	"strings"
	"time"
)

type OpenAIAdapter struct {
	baseURL    string
	apiKey     string
	client     *http.Client
	maxRetries int
}

func NewOpenAIAdapter(config AdapterConfig) *OpenAIAdapter {
	return &OpenAIAdapter{
		baseURL: config.BaseURL,
		apiKey:  config.APIKey,
		client: &http.Client{
			Timeout: config.Timeout,
		},
		maxRetries: config.MaxRetries,
	}
}

type openaiMessage struct {
	Role       string           `json:"role"`
	Content    string           `json:"content,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	ToolCalls  []openaiToolCall `json:"tool_calls,omitempty"`
}

type openaiTool struct {
	Type     string             `json:"type"`
	Function openaiToolFunction `json:"function"`
}

type openaiToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openaiToolCall struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`
	Function openaiToolCallFunction `json:"function"`
}

type openaiToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openaiResponse struct {
	ID      string         `json:"id"`
	Model   string         `json:"model"`
	Choices []openaiChoice `json:"choices"`
	Usage   openaiUsage    `json:"usage"`
}

type openaiChoice struct {
	Message openaiMessage `json:"message"`
}

type openaiUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type openaiErrorResponse struct {
	Error struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

func (ad *OpenAIAdapter) ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	endpoint := ad.baseURL + "/chat/completions"
	log.Printf("[openai] → POST %s model=%s messages=%d tools=%d", endpoint, req.Model, len(req.Messages), len(req.Tools))

	payload := ad.buildPayload(req)

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal openai request : %w", err)
	}
	log.Printf("[openai] request payload size=%d bytes", len(bodyBytes))

	var lastErr error
	start := time.Now()

	for attempt := 0; attempt <= ad.maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(math.Pow(2, float64(attempt-1))) * time.Second
			log.Printf("[openai] retry %d/%d after %v (last error: %v)", attempt, ad.maxRetries, backoff, lastErr)

			select {
			case <-ctx.Done():
				log.Printf("[openai] context cancelled during retry backoff")
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		attemptStart := time.Now()
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Authorization", "Bearer "+ad.apiKey)

		httpResp, err := ad.client.Do(httpReq)
		if err != nil {
			lastErr = fmt.Errorf("request failed: %w", err)
			log.Printf("[openai] ✗ network error attempt=%d elapsed=%v err=%v", attempt, time.Since(attemptStart), err)
			continue
		}

		respBody, err := io.ReadAll(httpResp.Body)
		httpResp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to read response: %w", err)
			log.Printf("[openai] ✗ read error attempt=%d err=%v", attempt, err)
			continue
		}

		log.Printf("[openai] ← status=%d response_size=%d bytes elapsed=%v", httpResp.StatusCode, len(respBody), time.Since(attemptStart))

		if httpResp.StatusCode != http.StatusOK {
			lastErr = ad.handleErrorStatus(httpResp.StatusCode, respBody)

			if httpResp.StatusCode == 429 || httpResp.StatusCode >= 500 {
				continue
			}
			return nil, lastErr
		}

		resp, err := ad.parseResponse(respBody)
		if err != nil {
			return nil, err
		}

		log.Printf("[openai] ✓ completed model=%s prompt=%d completion=%d total_elapsed=%v",
			resp.Model, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, time.Since(start))

		if len(resp.ToolCalls) > 0 {
			for _, tc := range resp.ToolCalls {
				log.Printf("[openai] ⚡ tool_call id=%s name=%s", tc.ID, tc.Name)
			}
		}

		return resp, nil
	}

	log.Printf("[openai] ✗ exhausted all %d retries total_elapsed=%v", ad.maxRetries, time.Since(start))
	return nil, fmt.Errorf("request failed after %d retries: %w", ad.maxRetries, lastErr)
}

func (a *OpenAIAdapter) parseResponse(body []byte) (*ChatResponse, error) {
	var raw openaiResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	if len(raw.Choices) == 0 {
		return nil, fmt.Errorf("empty choices in response")
	}
	choice := raw.Choices[0]
	resp := &ChatResponse{
		Content: choice.Message.Content,
		Model:   raw.Model,
		Usage: TokenUsage{
			PromptTokens:     raw.Usage.PromptTokens,
			CompletionTokens: raw.Usage.CompletionTokens,
			TotalTokens:      raw.Usage.TotalTokens,
		},
	}

	if len(choice.Message.ToolCalls) > 0 {
		resp.ToolCalls = make([]ToolCall, len(choice.Message.ToolCalls))
		for i, tc := range choice.Message.ToolCalls {
			resp.ToolCalls[i] = ToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: json.RawMessage(tc.Function.Arguments),
			}
		}
	}
	return resp, nil
}

func (a *OpenAIAdapter) handleErrorStatus(status int, body []byte) error {
	var errResp openaiErrorResponse
	json.Unmarshal(body, &errResp) // best-effort, ignore parse errors

	msg := errResp.Error.Message
	if msg == "" {
		msg = string(body)
	}

	log.Printf("[openai] error status=%d body=%s", status, msg)

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

func (ad *OpenAIAdapter) buildPayload(req *ChatRequest) map[string]any {

	messages := make([]openaiMessage, len(req.Messages))

	for i, m := range req.Messages {
		msg := openaiMessage{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
		}

		if len(m.ToolCalls) > 0 {
			msg.ToolCalls = make([]openaiToolCall, len(m.ToolCalls))

			for j, tc := range m.ToolCalls {
				msg.ToolCalls[j] = openaiToolCall{
					ID:   tc.ID,
					Type: "function",
					Function: openaiToolCallFunction{
						Name:      tc.Name,
						Arguments: string(tc.Arguments),
					},
				}
			}

		}
		messages[i] = msg
	}

	payload := map[string]interface{}{
		"model":    req.Model,
		"messages": messages,
	}

	if req.Temperature != 0 && !ad.usesDefaultOnlyTemperature(req.Model) {
		payload["temperature"] = req.Temperature
	}

	if req.MaxTokens > 0 {
		if ad.usesMaxCompletionTokens(req.Model) {
			payload["max_completion_tokens"] = req.MaxTokens
		} else {
			payload["max_tokens"] = req.MaxTokens
		}
	}

	if len(req.Tools) > 0 {
		tools := make([]openaiTool, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = openaiTool{
				Type: "function",
				Function: openaiToolFunction{
					Name:        t.Name,
					Description: t.Description,
					Parameters:  t.Parameters,
				},
			}
		}
		payload["tools"] = tools
	}

	for k, v := range req.Params {
		payload[k] = v
	}

	return payload
}

func (ad *OpenAIAdapter) usesMaxCompletionTokens(model string) bool {
	return strings.Contains(ad.baseURL, "api.openai.com") && ad.isReasoningModel(model)
}

func (ad *OpenAIAdapter) usesDefaultOnlyTemperature(model string) bool {
	return strings.Contains(ad.baseURL, "api.openai.com") && ad.isReasoningModel(model)
}

func (ad *OpenAIAdapter) isReasoningModel(model string) bool {
	model = strings.ToLower(model)

	return strings.HasPrefix(model, "o1") ||
		strings.HasPrefix(model, "o3") ||
		strings.HasPrefix(model, "o4") ||
		strings.HasPrefix(model, "gpt-5")
}
