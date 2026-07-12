package llm

import (
	"fmt"
	"log"
	"os"
	"sort"
	"time"
)

type providerSpec struct {
	name   string
	envKey string
	build  func(string) LLMClient
}

var providerSpecs = []providerSpec{
	{
		name: "openai", envKey: "OPENAI_API_KEY",
		build: func(key string) LLMClient {
			return NewOpenAIAdapter(AdapterConfig{APIKey: key, BaseURL: "https://api.openai.com/v1", MaxRetries: 3, Timeout: 30 * time.Second})
		},
	},
	{
		name: "nvidia", envKey: "NVIDIA_API_KEY",
		build: func(key string) LLMClient {
			return NewOpenAIAdapter(AdapterConfig{APIKey: key, BaseURL: "https://integrate.api.nvidia.com/v1", MaxRetries: 3, Timeout: 30 * time.Second})
		},
	},
	{
		name: "anthropic", envKey: "ANTHROPIC_API_KEY",
		build: func(key string) LLMClient {
			return NewAnthropicAdapter(AdapterConfig{APIKey: key, MaxRetries: 3, Timeout: 60 * time.Second})
		},
	},
}

type LLMRegistry struct {
	clients map[string]LLMClient
}

// NewEmptyLLMRegistry returns an initialised but empty registry. Useful in
// tests that register fake providers rather than reading from env vars.
func NewEmptyLLMRegistry() *LLMRegistry {
	return &LLMRegistry{clients: make(map[string]LLMClient)}
}

// Register adds a provider directly. Useful for testing and for dynamic
// provider injection outside of NewLLMRegistry.
func (r *LLMRegistry) Register(provider string, client LLMClient) {
	r.clients[provider] = client
}

func NewLLMRegistry() *LLMRegistry {
	r := NewEmptyLLMRegistry()
	for _, spec := range providerSpecs {
		key := os.Getenv(spec.envKey)
		if key == "" {
			log.Printf("%s api skipped (%s not set)", spec.name, spec.envKey)
			continue
		}
		r.clients[spec.name] = spec.build(key)
		log.Printf("%s api registered", spec.name)
	}
	log.Printf("%d provider(s) available", len(r.clients))
	return r
}

func SupportedProviders() []string {
	providers := make([]string, len(providerSpecs))
	for i, spec := range providerSpecs {
		providers[i] = spec.name
	}
	sort.Strings(providers)
	return providers
}

func IsSupportedProvider(name string) bool {
	for _, spec := range providerSpecs {
		if spec.name == name {
			return true
		}
	}
	return false
}

func (r *LLMRegistry) Get(provider string) (LLMClient, error) {

	client, ok := r.clients[provider]

	if !ok {
		return nil, fmt.Errorf("provider %q not registered or missing API key", provider)
	}

	return client, nil
}

func (r *LLMRegistry) Available() []string {

	providers := make([]string, 0, len(r.clients))

	for k := range r.clients {
		providers = append(providers, k)
	}

	return providers
}
