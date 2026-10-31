package integration_test

import (
	"context"
	"net/http"
	"testing"

	"backend/handlers"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestGetLLMsReturnsSeededAvailableModel(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "llm-empty@example.com", "password123")

	resp := e.do(t, "GET", "/api/llms", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var models []handlers.LLMModelResponse
	decodeBody(t, resp, &models)
	if len(models) != 1 || models[0].APIModelID != "gpt-4o" || !models[0].Available {
		t.Fatalf("unexpected models: %+v", models)
	}
}

func TestGetLLMsWithModelsReturnsAll(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "llm-models@example.com", "password123")

	// Seed two model documents directly into the collection.
	docs := []interface{}{
		bson.M{
			"model_id":       "gpt-4.1",
			"name":           "GPT-4.1",
			"provider":       "openai",
			"api_model_id":   "gpt-4.1",
			"context_window": 128000,
		},
		bson.M{
			"model_id":       "claude-3",
			"name":           "Claude 3 Opus",
			"provider":       "anthropic",
			"api_model_id":   "claude-3-opus-20240229",
			"context_window": 200000,
		},
	}
	if _, err := e.llmModelCol.InsertMany(context.Background(), docs); err != nil {
		t.Fatalf("seed LLM models: %v", err)
	}

	resp := e.do(t, "GET", "/api/llms", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var models []handlers.LLMModelResponse
	decodeBody(t, resp, &models)
	if len(models) != 3 {
		t.Errorf("expected 3 models, got %d", len(models))
	}
	availability := map[string]bool{}
	for _, entry := range models {
		availability[entry.Provider] = entry.Available
	}
	if !availability["openai"] || availability["anthropic"] {
		t.Errorf("unexpected provider availability: %+v", availability)
	}
}

func TestChatUnknownProviderReturns400(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "llm-chat@example.com", "password123")

	resp := e.do(t, "POST", "/api/llm/chat", map[string]any{
		"provider": "nonexistent-provider",
		"model":    "some-model",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	}, token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}
