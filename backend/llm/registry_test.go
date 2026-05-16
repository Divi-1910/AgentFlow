package llm_test

import (
	"context"
	"testing"

	"backend/llm"
)

// fakeLLMClient is a minimal LLMClient for registry tests.
type fakeLLMClient struct{}

func (f *fakeLLMClient) ChatCompletion(_ context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
	return &llm.ChatResponse{Content: "fake"}, nil
}

func TestNewEmptyLLMRegistryHasNoProviders(t *testing.T) {
	t.Parallel()
	r := llm.NewEmptyLLMRegistry()
	providers := r.Available()
	if len(providers) != 0 {
		t.Errorf("expected 0 providers, got %d: %v", len(providers), providers)
	}
}

func TestRegisterAndGetRoundTrip(t *testing.T) {
	t.Parallel()
	r := llm.NewEmptyLLMRegistry()
	client := &fakeLLMClient{}
	r.Register("openai", client)

	got, err := r.Get("openai")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != client {
		t.Error("Get returned a different client than what was registered")
	}
}

func TestGetReturnsErrorForUnregisteredProvider(t *testing.T) {
	t.Parallel()
	r := llm.NewEmptyLLMRegistry()

	_, err := r.Get("nonexistent")
	if err == nil {
		t.Error("expected error for unregistered provider, got nil")
	}
}

func TestAvailableListsAllRegisteredProviders(t *testing.T) {
	t.Parallel()
	r := llm.NewEmptyLLMRegistry()
	r.Register("openai", &fakeLLMClient{})
	r.Register("anthropic", &fakeLLMClient{})

	providers := r.Available()
	if len(providers) != 2 {
		t.Fatalf("expected 2 providers, got %d: %v", len(providers), providers)
	}
	got := map[string]bool{}
	for _, p := range providers {
		got[p] = true
	}
	for _, want := range []string{"openai", "anthropic"} {
		if !got[want] {
			t.Errorf("provider %q missing from Available()", want)
		}
	}
}

func TestRegisterOverwritesExistingProvider(t *testing.T) {
	t.Parallel()
	r := llm.NewEmptyLLMRegistry()
	original := &fakeLLMClient{}
	replacement := &fakeLLMClient{}

	r.Register("openai", original)
	r.Register("openai", replacement)

	got, err := r.Get("openai")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != replacement {
		t.Error("Register should overwrite existing provider")
	}
	if len(r.Available()) != 1 {
		t.Errorf("expected 1 provider after overwrite, got %d", len(r.Available()))
	}
}
