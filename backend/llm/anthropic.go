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
	"sort"
	"strings"
	"time"
)

const (
	anthropicDefaultMaxTokens = 8192
	anthropicAPIVersion       = "2023-06-01"
)

type AnthropicAdapter struct {
	baseURL    string
	apiKey     string
	client     *http.Client
	maxRetries int
}

func NewAnthropicAdapter(config AdapterConfig) *AnthropicAdapter {
	baseURL := config.BaseURL
	if baseURL == "" {
		baseURL = "https://api.anthropic.com/v1"
	}
	return &AnthropicAdapter{
		baseURL: baseURL,
		apiKey:  config.APIKey,
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

type anthropicStreamEnvelope struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		Model string         `json:"model"`
		Usage anthropicUsage `json:"usage"`
	} `json:"message"`
	ContentBlock *struct {
		Type  string          `json:"type"`
		Text  string          `json:"text"`
		ID    string          `json:"id"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	} `json:"content_block"`
	Delta struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage anthropicUsage `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

type anthropicToolAccumulator struct {
	id      string
	name    string
	initial json.RawMessage
	partial strings.Builder
}

func (a *AnthropicAdapter) ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	endpoint := a.baseURL + "/messages"
	log.Printf("[anthropic] → POST %s model=%s messages=%d tools=%d", endpoint, req.Model, len(req.Messages), len(req.Tools))

	payload := a.buildPayload(req)

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}
	log.Printf("[anthropic] request payload size=%d bytes", len(bodyBytes))

	var lastErr error
	start := time.Now()

	for attempt := 0; attempt <= a.maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(math.Pow(2, float64(attempt-1))) * time.Second
			log.Printf("[anthropic] retry %d/%d after %v (last error: %v)", attempt, a.maxRetries, backoff, lastErr)

			select {
			case <-ctx.Done():
				log.Printf("[anthropic] context cancelled during retry backoff")
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
		httpReq.Header.Set("x-api-key", a.apiKey)
		httpReq.Header.Set("anthropic-version", anthropicAPIVersion)

		resp, err := a.client.Do(httpReq)
		if err != nil {
			lastErr = fmt.Errorf("request failed: %w", err)
			log.Printf("[anthropic] ✗ network error attempt=%d elapsed=%v err=%v", attempt, time.Since(attemptStart), err)
			continue
		}

		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to read response: %w", err)
			log.Printf("[anthropic] ✗ read error attempt=%d err=%v", attempt, err)
			continue
		}

		log.Printf("[anthropic] ← status=%d response_size=%d bytes elapsed=%v", resp.StatusCode, len(respBody), time.Since(attemptStart))

		if resp.StatusCode != http.StatusOK {
			lastErr = a.handleErrorStatus(resp.StatusCode, respBody)
			if resp.StatusCode == 429 || resp.StatusCode >= 500 {
				continue
			}
			return nil, lastErr
		}

		result, err := a.parseResponse(respBody)
		if err != nil {
			return nil, err
		}

		log.Printf("[anthropic] ✓ completed model=%s prompt=%d completion=%d total_elapsed=%v",
			result.Model, result.Usage.PromptTokens, result.Usage.CompletionTokens, time.Since(start))

		if len(result.ToolCalls) > 0 {
			for _, tc := range result.ToolCalls {
				log.Printf("[anthropic] ⚡ tool_call id=%s name=%s", tc.ID, tc.Name)
			}
		}

		return result, nil
	}

	log.Printf("[anthropic] ✗ exhausted all %d retries total_elapsed=%v", a.maxRetries, time.Since(start))
	return nil, fmt.Errorf("request failed after %d retries: %w", a.maxRetries, lastErr)
}

// ChatCompletionStream consumes Anthropic's message event stream. Thinking
// events and partial tool JSON are intentionally not projected to callers;
// only text_delta content is display-safe.
func (a *AnthropicAdapter) ChatCompletionStream(ctx context.Context, req *ChatRequest, onTextDelta TextDeltaHandler) (*ChatResponse, error) {
	endpoint := a.baseURL + "/messages"
	payload := a.buildPayload(req)
	payload["stream"] = true

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal anthropic streaming request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= a.maxRetries; attempt++ {
		if err := waitForRetry(ctx, attempt); err != nil {
			return nil, err
		}

		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, fmt.Errorf("failed to create anthropic streaming request: %w", err)
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Accept", "text/event-stream")
		httpReq.Header.Set("x-api-key", a.apiKey)
		httpReq.Header.Set("anthropic-version", anthropicAPIVersion)

		httpResp, err := a.client.Do(httpReq)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = fmt.Errorf("anthropic streaming request failed: %w", err)
			continue
		}

		if httpResp.StatusCode != http.StatusOK {
			respBody, readErr := io.ReadAll(io.LimitReader(httpResp.Body, 64<<10))
			httpResp.Body.Close()
			if readErr != nil {
				lastErr = fmt.Errorf("failed to read anthropic error response: %w", readErr)
			} else {
				lastErr = a.handleErrorStatus(httpResp.StatusCode, respBody)
			}
			if httpResp.StatusCode == http.StatusTooManyRequests || httpResp.StatusCode >= 500 {
				continue
			}
			return nil, lastErr
		}

		response, visible, retryable, streamErr := consumeAnthropicStream(ctx, httpResp.Body, onTextDelta)
		httpResp.Body.Close()
		if streamErr == nil {
			return response, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if visible {
			return nil, fmt.Errorf("%w: %v", ErrStreamInterrupted, streamErr)
		}
		lastErr = streamErr
		if !retryable {
			return nil, streamErr
		}
	}

	return nil, fmt.Errorf("anthropic streaming request failed after %d retries: %w", a.maxRetries, lastErr)
}

func consumeAnthropicStream(ctx context.Context, body io.Reader, onTextDelta TextDeltaHandler) (*ChatResponse, bool, bool, error) {
	response := &ChatResponse{}
	tools := make(map[int]*anthropicToolAccumulator)
	visible := false
	done := false
	var protocolErr error
	var providerErr error
	var callbackErr error

	emitText := func(delta string) error {
		if delta == "" {
			return nil
		}
		visible = true
		response.Content += delta
		if onTextDelta == nil {
			return nil
		}
		if err := onTextDelta(delta); err != nil {
			callbackErr = err
			return err
		}
		return nil
	}

	err := readSSE(ctx, body, func(event sseEvent) error {
		var envelope anthropicStreamEnvelope
		if err := json.Unmarshal([]byte(event.Data), &envelope); err != nil {
			protocolErr = fmt.Errorf("parse anthropic stream event: %w", err)
			return protocolErr
		}
		if envelope.Type == "" {
			envelope.Type = event.Name
		}

		switch envelope.Type {
		case "message_start":
			if envelope.Message != nil {
				response.Model = envelope.Message.Model
				response.Usage.PromptTokens = envelope.Message.Usage.InputTokens
				response.Usage.CompletionTokens = envelope.Message.Usage.OutputTokens
			}
		case "content_block_start":
			if envelope.ContentBlock == nil {
				return nil
			}
			switch envelope.ContentBlock.Type {
			case "text":
				return emitText(envelope.ContentBlock.Text)
			case "tool_use":
				tools[envelope.Index] = &anthropicToolAccumulator{
					id:      envelope.ContentBlock.ID,
					name:    envelope.ContentBlock.Name,
					initial: append(json.RawMessage(nil), envelope.ContentBlock.Input...),
				}
			}
		case "content_block_delta":
			switch envelope.Delta.Type {
			case "text_delta":
				return emitText(envelope.Delta.Text)
			case "input_json_delta":
				tool := tools[envelope.Index]
				if tool == nil {
					tool = &anthropicToolAccumulator{}
					tools[envelope.Index] = tool
				}
				tool.partial.WriteString(envelope.Delta.PartialJSON)
			}
		case "message_delta":
			response.Usage.CompletionTokens = envelope.Usage.OutputTokens
		case "message_stop":
			done = true
		case "error":
			if envelope.Error == nil {
				providerErr = fmt.Errorf("anthropic stream returned an unspecified provider error")
			} else {
				providerErr = fmt.Errorf("anthropic stream error (%s): %s", envelope.Error.Type, envelope.Error.Message)
			}
			return providerErr
		}
		// ping, thinking_delta, signature_delta, and unknown future events do
		// not belong in the user-visible text projection.
		return nil
	})
	if err != nil {
		switch {
		case callbackErr != nil:
			return nil, visible, false, callbackErr
		case protocolErr != nil:
			return nil, visible, false, protocolErr
		case providerErr != nil:
			return nil, visible, true, providerErr
		default:
			return nil, visible, true, err
		}
	}
	if !done {
		return nil, visible, true, io.ErrUnexpectedEOF
	}

	indices := make([]int, 0, len(tools))
	for index := range tools {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	for _, index := range indices {
		tool := tools[index]
		arguments := tool.partial.String()
		if arguments == "" {
			arguments = string(tool.initial)
		}
		if arguments == "" || arguments == "null" {
			arguments = "{}"
		}
		response.ToolCalls = append(response.ToolCalls, ToolCall{
			ID:        tool.id,
			Name:      tool.name,
			Arguments: json.RawMessage(arguments),
		})
	}
	response.Usage.TotalTokens = response.Usage.PromptTokens + response.Usage.CompletionTokens
	return response, visible, false, nil
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

	if system != "" {
		log.Printf("[anthropic] extracted system message (%d chars) → top-level field", len(system))
	}
	log.Printf("[anthropic] building payload: %d user/assistant messages, max_tokens=%d", len(messages), req.MaxTokens)

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

	log.Printf("[anthropic] error status=%d type=%s body=%s", status, errResp.Error.Type, msg)

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
