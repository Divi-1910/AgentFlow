package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOpenAIChatCompletionStreamReconstructsResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", got)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if payload["stream"] != true {
			t.Errorf("stream = %#v, want true", payload["stream"])
		}
		streamOptions, _ := payload["stream_options"].(map[string]any)
		if streamOptions["include_usage"] != true {
			t.Errorf("stream_options = %#v, want include_usage=true", streamOptions)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"content\":\"Hel\",\"reasoning_content\":\"hidden\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\"}}]}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Pune\\\"}\"}}]}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	adapter := NewOpenAIAdapter(AdapterConfig{
		APIKey:     "test-key",
		BaseURL:    server.URL,
		MaxRetries: 0,
		Timeout:    time.Second,
	})
	var deltas []string
	response, err := adapter.ChatCompletionStream(context.Background(), &ChatRequest{Model: "gpt-test"}, func(delta string) error {
		deltas = append(deltas, delta)
		return nil
	})
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if got := strings.Join(deltas, ""); got != "Hello" {
		t.Fatalf("visible deltas = %q, want Hello", got)
	}
	if response.Content != "Hello" || response.Model != "gpt-test" {
		t.Fatalf("response = %+v", response)
	}
	if response.Usage != (TokenUsage{PromptTokens: 7, CompletionTokens: 3, TotalTokens: 10}) {
		t.Fatalf("usage = %+v", response.Usage)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v", response.ToolCalls)
	}
	toolCall := response.ToolCalls[0]
	if toolCall.ID != "call-1" || toolCall.Name != "weather" || string(toolCall.Arguments) != `{"city":"Pune"}` {
		t.Fatalf("tool call = %+v", toolCall)
	}
}

func TestOpenAIChatCompletionStreamRetriesBeforeVisibleOutput(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			http.Error(w, "temporary outage", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"content\":\"recovered\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	adapter := NewOpenAIAdapter(AdapterConfig{
		APIKey:     "test-key",
		BaseURL:    server.URL,
		MaxRetries: 1,
		Timeout:    3 * time.Second,
	})
	response, err := adapter.ChatCompletionStream(context.Background(), &ChatRequest{Model: "gpt-test"}, func(string) error { return nil })
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if response.Content != "recovered" {
		t.Fatalf("content = %q, want recovered", response.Content)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("requests = %d, want 2", got)
	}
}

func TestOpenAIChatCompletionStreamDoesNotRetryAfterVisibleOutput(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		// Closing without [DONE] simulates a provider connection dropping after
		// the user has already observed output.
	}))
	defer server.Close()

	adapter := NewOpenAIAdapter(AdapterConfig{
		APIKey:     "test-key",
		BaseURL:    server.URL,
		MaxRetries: 3,
		Timeout:    time.Second,
	})
	_, err := adapter.ChatCompletionStream(context.Background(), &ChatRequest{Model: "gpt-test"}, func(string) error { return nil })
	if !errors.Is(err, ErrStreamInterrupted) {
		t.Fatalf("error = %v, want ErrStreamInterrupted", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("requests = %d, want 1 (no retry after visible output)", got)
	}
}
