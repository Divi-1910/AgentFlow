package llm

import (
	"fmt"
	"log"
	"os"
	"time"
)

type LLMRegistry struct {
	clients map[string]LLMClient
}

func NewLLMRegistry() *LLMRegistry {
	r := &LLMRegistry{
		clients: make(map[string]LLMClient),
	}

	if key := os.Getenv("OPENAI_API_KEY"); key != "" {

		r.clients["openai"] = NewOpenAIAdapter(AdapterConfig{
			APIKey:     key,
			BaseURL:    "https://api.openai.com/v1",
			MaxRetries: 3,
			Timeout:    30 * time.Second,
		})

		log.Println("openai api registered")

	} else {

		log.Println(" openai api skipped (OPENAI_API_KEY not set)")

	}

	// NVIDIA is OpenAI Compatible
	if key := os.Getenv("NVIDIA_API_KEY"); key != "" {

		r.clients["nvidia"] = NewOpenAIAdapter(AdapterConfig{
			APIKey:     key,
			BaseURL:    "https://integrate.api.nvidia.com/v1",
			MaxRetries: 3,
			Timeout:    30 * time.Second,
		})

		log.Println("nvidia api registered")

	} else {

		log.Println(" nvidia api skipped (NVIDIA_API_KEY not set)")

	}

	if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {

		r.clients["anthropic"] = NewAnthropicAdapter(AdapterConfig{
			APIKey:     key,
			MaxRetries: 3,
			Timeout:    60 * time.Second,
		})

		log.Println("anthropic api registered")

	} else {

		log.Println(" anthropic api skipped (ANTHROPIC_API_KEY not set)")

	}

	log.Printf("%d provider(s) available", len(r.clients))

	return r
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
