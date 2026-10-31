package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAnthropicChatCompletionStreamProjectsTextAndReconstructsToolUse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if payload["stream"] != true {
			t.Errorf("stream = %#v, want true", payload["stream"])
		}

		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-test\",\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\n")
		fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Hi \"}}\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hidden\"}}\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"there\"}}\n\n")
		fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"weather\",\"input\":{}}}\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\"}}\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"Pune\\\"}\"}}\n\n")
		fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":9}}\n\n")
		fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()

	adapter := NewAnthropicAdapter(AdapterConfig{
		APIKey:     "test-key",
		BaseURL:    server.URL,
		MaxRetries: 0,
		Timeout:    time.Second,
	})
	var deltas []string
	response, err := adapter.ChatCompletionStream(context.Background(), &ChatRequest{Model: "claude-test"}, func(delta string) error {
		deltas = append(deltas, delta)
		return nil
	})
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if got := strings.Join(deltas, ""); got != "Hi there" {
		t.Fatalf("visible deltas = %q, want Hi there", got)
	}
	if response.Content != "Hi there" || response.Model != "claude-test" {
		t.Fatalf("response = %+v", response)
	}
	if response.Usage != (TokenUsage{PromptTokens: 11, CompletionTokens: 9, TotalTokens: 20}) {
		t.Fatalf("usage = %+v", response.Usage)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v", response.ToolCalls)
	}
	toolCall := response.ToolCalls[0]
	if toolCall.ID != "tool-1" || toolCall.Name != "weather" || string(toolCall.Arguments) != `{"city":"Pune"}` {
		t.Fatalf("tool call = %+v", toolCall)
	}
}
