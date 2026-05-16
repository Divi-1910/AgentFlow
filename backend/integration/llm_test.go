package integration_test

import (
	"context"
	"net/http"
	"testing"

	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestGetLLMsEmptyReturns200(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "llm-empty@example.com", "password123")

	resp := e.do(t, "GET", "/api/llms", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var models []any
	decodeBody(t, resp, &models)
	if models == nil {
		t.Error("expected non-nil slice, got nil")
	}
}

func TestGetLLMsWithModelsReturnsAll(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "llm-models@example.com", "password123")

	// Seed two model documents directly into the collection.
	docs := []interface{}{
		bson.M{
			"model_id":       "gpt-4o",
			"name":           "GPT-4o",
			"provider":       "openai",
			"api_model_id":   "gpt-4o",
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
	var models []model.LLMModel
	decodeBody(t, resp, &models)
	if len(models) != 2 {
		t.Errorf("expected 2 models, got %d", len(models))
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
