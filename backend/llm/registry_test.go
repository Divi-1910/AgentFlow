package llm_test

import (
	"context"
	"reflect"
	"testing"

	"backend/llm"
)

// fakeLLMClient is a minimal LLMClient for registry tests.
type fakeLLMClient struct{}

func (f *fakeLLMClient) ChatCompletion(_ context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
	return &llm.ChatResponse{Content: "fake"}, nil
}

func TestSupportedProvidersAreSortedAndDefensive(t *testing.T) {
	want := []string{"anthropic", "nvidia", "openai"}
	got := llm.SupportedProviders()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SupportedProviders = %v, want %v", got, want)
	}
	got[0] = "mutated"
	if reflect.DeepEqual(llm.SupportedProviders(), got) {
		t.Fatal("SupportedProviders returned shared storage")
	}
	for _, provider := range want {
		if !llm.IsSupportedProvider(provider) {
			t.Fatalf("IsSupportedProvider(%q) = false", provider)
		}
	}
	if llm.IsSupportedProvider("fake") {
		t.Fatal("fake provider reported supported")
	}
}

func TestNewLLMRegistryUsesSupportedProviderTable(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test")
	t.Setenv("NVIDIA_API_KEY", "test")
	t.Setenv("ANTHROPIC_API_KEY", "test")
	r := llm.NewLLMRegistry()
	for _, provider := range llm.SupportedProviders() {
		if _, err := r.Get(provider); err != nil {
			t.Fatalf("provider %q not registered: %v", provider, err)
		}
	}
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
