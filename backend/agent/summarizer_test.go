package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"backend/llm"
)

// fakeLLMClient is a minimal LLMClient for summarizer tests.
type fakeLLMClient struct {
	completionFn func(context.Context, *llm.ChatRequest) (*llm.ChatResponse, error)
}

func (f *fakeLLMClient) ChatCompletion(ctx context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	if f.completionFn != nil {
		return f.completionFn(ctx, req)
	}
	return &llm.ChatResponse{Content: "mocked summary", Model: req.Model}, nil
}

func newSummarizer() *Summarizer {
	return NewSummarizer(llm.NewEmptyLLMRegistry())
}

// ── preprocessMessage ─────────────────────────────────────────────────────────

func TestPreprocessMessageAssistantWithContent(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	msg := llm.ChatMessage{Role: "assistant", Content: "  Hello!  "}
	got := s.preprocessMessage(msg)
	if !strings.Contains(got, "assistant: Hello!") {
		t.Errorf("got %q, want to contain %q", got, "assistant: Hello!")
	}
}

func TestPreprocessMessageAssistantWithToolCalls(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	msg := llm.ChatMessage{
		Role:      "assistant",
		ToolCalls: []llm.ToolCall{{Name: "calculator"}, {Name: "http_request"}},
	}
	got := s.preprocessMessage(msg)
	if !strings.Contains(got, "calculator") || !strings.Contains(got, "http_request") {
		t.Errorf("got %q, want tool names", got)
	}
	if strings.Contains(got, "assistant:") {
		t.Error("tool-call messages should not include 'assistant:' prefix")
	}
}

func TestPreprocessMessageEmptyAssistant(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	msg := llm.ChatMessage{Role: "assistant", Content: "   "}
	got := s.preprocessMessage(msg)
	if got != "" {
		t.Errorf("got %q, want empty string for blank assistant message", got)
	}
}

func TestPreprocessMessageToolRoleWithinLimit(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	msg := llm.ChatMessage{Role: "tool", Content: "result"}
	got := s.preprocessMessage(msg)
	if !strings.Contains(got, "tool result: result") {
		t.Errorf("got %q, want %q", got, "tool result: result")
	}
}

func TestPreprocessMessageToolRoleTruncatesLongContent(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	long := strings.Repeat("x", 300)
	msg := llm.ChatMessage{Role: "tool", Content: long}
	got := s.preprocessMessage(msg)
	if !strings.Contains(got, "[truncated]") {
		t.Errorf("expected [truncated] in output, got: %q", got)
	}
	if len(got) >= len(long) {
		t.Error("expected truncated output to be shorter than input")
	}
}

func TestPreprocessMessageUnknownRoleReturnsEmpty(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	msg := llm.ChatMessage{Role: "system", Content: "some system prompt"}
	got := s.preprocessMessage(msg)
	if got != "" {
		t.Errorf("unknown role: got %q, want empty string", got)
	}
}

// ── buildSummarizationInput ───────────────────────────────────────────────────

func TestBuildSummarizationInputNoPreviousSummary(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	turns := []Turn{
		{
			UserMessage: llm.ChatMessage{Role: "user", Content: "What is 2+2?"},
			AgentMessages: []llm.ChatMessage{
				{Role: "assistant", Content: "4"},
			},
		},
	}
	out := s.buildSummarizationInput("", turns)
	if strings.Contains(out, "Previous summary:") {
		t.Error("empty previous summary should not produce 'Previous summary:' section")
	}
	if !strings.Contains(out, "What is 2+2?") {
		t.Error("output should contain user message")
	}
	if !strings.Contains(out, "4") {
		t.Error("output should contain assistant response")
	}
}

func TestBuildSummarizationInputWithPreviousSummary(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	out := s.buildSummarizationInput("earlier context here", []Turn{
		{UserMessage: llm.ChatMessage{Role: "user", Content: "hello"}},
	})
	if !strings.Contains(out, "Previous summary:") {
		t.Error("non-empty previous summary should produce 'Previous summary:' section")
	}
	if !strings.Contains(out, "earlier context here") {
		t.Error("output should contain the previous summary text")
	}
}

func TestBuildSummarizationInputMultipleTurns(t *testing.T) {
	t.Parallel()
	s := newSummarizer()
	turns := []Turn{
		{UserMessage: llm.ChatMessage{Role: "user", Content: "first"}},
		{UserMessage: llm.ChatMessage{Role: "user", Content: "second"}},
	}
	out := s.buildSummarizationInput("", turns)
	if !strings.Contains(out, "first") || !strings.Contains(out, "second") {
		t.Error("output should contain both turns")
	}
}

// ── Summarize ─────────────────────────────────────────────────────────────────

func TestSummarizeReturnsErrorWhenProviderNotRegistered(t *testing.T) {
	t.Parallel()
	s := newSummarizer() // empty registry — no providers registered
	ag := &Agent{Provider: "openai", Model: "gpt-4"}
	_, _, err := s.Summarize(context.Background(), ag, "", nil)
	if err == nil {
		t.Error("expected error when provider not registered")
	}
}

func TestSummarizeReturnsLLMError(t *testing.T) {
	t.Parallel()
	reg := llm.NewEmptyLLMRegistry()
	reg.Register("fake", &fakeLLMClient{
		completionFn: func(_ context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
			return nil, errors.New("upstream failed")
		},
	})
	s := NewSummarizer(reg)
	ag := &Agent{Provider: "fake", Model: "fake-model", MaxSteps: 5}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled so retry backoff doesn't block
	_, _, err := s.Summarize(ctx, ag, "", nil)
	if err == nil {
		t.Error("expected error when LLM call fails")
	}
}

func TestSummarizeReturnsSummaryOnSuccess(t *testing.T) {
	t.Parallel()
	reg := llm.NewEmptyLLMRegistry()
	reg.Register("fake", &fakeLLMClient{
		completionFn: func(_ context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
			return &llm.ChatResponse{
				Content: "This is the summary.",
				Model:   "fake-model",
				Usage:   llm.TokenUsage{TotalTokens: 42},
			}, nil
		},
	})
	s := NewSummarizer(reg)
	ag := &Agent{Provider: "fake", Model: "fake-model"}

	summary, usage, err := s.Summarize(context.Background(), ag, "", nil)
	if err != nil {
		t.Fatalf("Summarize: %v", err)
	}
	if summary != "This is the summary." {
		t.Errorf("summary: got %q, want %q", summary, "This is the summary.")
	}
	if usage.TotalTokens != 42 {
		t.Errorf("usage.TotalTokens: got %d, want 42", usage.TotalTokens)
	}
}

func TestSummarizeUsesSummarizationModelWhenSet(t *testing.T) {
	t.Parallel()
	reg := llm.NewEmptyLLMRegistry()
	var capturedModel string
	reg.Register("fake", &fakeLLMClient{
		completionFn: func(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
			capturedModel = req.Model
			return &llm.ChatResponse{Content: "ok", Model: req.Model}, nil
		},
	})
	s := NewSummarizer(reg)
	ag := &Agent{Provider: "fake", Model: "default-model", SummarizationModel: "summarize-model"}

	_, _, err := s.Summarize(context.Background(), ag, "", nil)
	if err != nil {
		t.Fatalf("Summarize: %v", err)
	}
	if capturedModel != "summarize-model" {
		t.Errorf("model used: got %q, want %q", capturedModel, "summarize-model")
	}
}
