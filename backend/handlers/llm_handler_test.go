package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"backend/handlers"
	"backend/llm"
	"backend/model"
)

// ── fakeLLMModelStore ─────────────────────────────────────────────────────────

type fakeLLMModelStore struct {
	listAllFn func(context.Context) ([]model.LLMModel, error)
}

func (f *fakeLLMModelStore) ListAll(ctx context.Context) ([]model.LLMModel, error) {
	if f.listAllFn != nil {
		return f.listAllFn(ctx)
	}
	return []model.LLMModel{}, nil
}

// ── fakeLLMClientRegistry ─────────────────────────────────────────────────────

type fakeLLMClientRegistry struct {
	getFn func(provider string) (llm.LLMClient, error)
}

func (f *fakeLLMClientRegistry) Get(provider string) (llm.LLMClient, error) {
	if f.getFn != nil {
		return f.getFn(provider)
	}
	return nil, errors.New("provider not registered")
}

// ── fakeLLMClient ─────────────────────────────────────────────────────────────

type fakeLLMClient struct {
	completionFn func(context.Context, *llm.ChatRequest) (*llm.ChatResponse, error)
}

func (f *fakeLLMClient) ChatCompletion(ctx context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	if f.completionFn != nil {
		return f.completionFn(ctx, req)
	}
	return &llm.ChatResponse{Content: "hello", Model: req.Model}, nil
}

// ── constructor helpers ───────────────────────────────────────────────────────

func newLLMHandler(ms *fakeLLMModelStore, reg *fakeLLMClientRegistry) *handlers.LLMHandler {
	return handlers.NewLLMHandler(ms, reg)
}

// registryWith returns a registry that serves the given client for any provider.
func registryWith(client llm.LLMClient) *fakeLLMClientRegistry {
	return &fakeLLMClientRegistry{
		getFn: func(_ string) (llm.LLMClient, error) {
			return client, nil
		},
	}
}

func chatBody(provider, model, content string) *strings.Reader {
	return strings.NewReader(`{"provider":"` + provider + `","model":"` + model +
		`","messages":[{"role":"user","content":"` + content + `"}]}`)
}

// ── GetLLMs ───────────────────────────────────────────────────────────────────

func TestGetLLMsRejects405ForPost(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodPost, "/api/llms", nil)
	w := httptest.NewRecorder()
	h.GetLLMs(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want 405", w.Code)
	}
}

func TestGetLLMsReturns500WhenStoreFails(t *testing.T) {
	t.Parallel()
	ms := &fakeLLMModelStore{
		listAllFn: func(_ context.Context) ([]model.LLMModel, error) {
			return nil, errors.New("db error")
		},
	}
	h := newLLMHandler(ms, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodGet, "/api/llms", nil)
	w := httptest.NewRecorder()
	h.GetLLMs(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestGetLLMsReturns200WithEmptySlice(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodGet, "/api/llms", nil)
	w := httptest.NewRecorder()
	h.GetLLMs(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var models []model.LLMModel
	decodeJSON(t, w.Body.Bytes(), &models)
	if len(models) != 0 {
		t.Errorf("expected empty slice, got %v", models)
	}
}

func TestGetLLMsReturns200WithModels(t *testing.T) {
	t.Parallel()
	ms := &fakeLLMModelStore{
		listAllFn: func(_ context.Context) ([]model.LLMModel, error) {
			return []model.LLMModel{
				{ModelID: "m1", Name: "GPT-4", Provider: "openai"},
			}, nil
		},
	}
	h := newLLMHandler(ms, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodGet, "/api/llms", nil)
	w := httptest.NewRecorder()
	h.GetLLMs(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var models []model.LLMModel
	decodeJSON(t, w.Body.Bytes(), &models)
	if len(models) != 1 || models[0].ModelID != "m1" {
		t.Errorf("unexpected models: %v", models)
	}
}

// ── Chat ──────────────────────────────────────────────────────────────────────

func TestChatRejects405ForGet(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodGet, "/api/chat", nil)
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want 405", w.Code)
	}
}

func TestChatReturns400OnInvalidBody(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader("not-json"))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestChatReturns400WhenProviderMissing(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodPost, "/api/chat",
		strings.NewReader(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestChatReturns400WhenModelMissing(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodPost, "/api/chat",
		strings.NewReader(`{"provider":"openai","messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestChatReturns400WhenMessagesEmpty(t *testing.T) {
	t.Parallel()
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodPost, "/api/chat",
		strings.NewReader(`{"provider":"openai","model":"gpt-4","messages":[]}`))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestChatReturns400WhenProviderNotRegistered(t *testing.T) {
	t.Parallel()
	// default registry returns error for all providers
	h := newLLMHandler(&fakeLLMModelStore{}, &fakeLLMClientRegistry{})
	r := httptest.NewRequest(http.MethodPost, "/api/chat",
		chatBody("unknown-provider", "gpt-4", "hello"))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestChatReturns502WhenCompletionFails(t *testing.T) {
	t.Parallel()
	client := &fakeLLMClient{
		completionFn: func(_ context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
			return nil, errors.New("upstream timeout")
		},
	}
	h := newLLMHandler(&fakeLLMModelStore{}, registryWith(client))
	r := httptest.NewRequest(http.MethodPost, "/api/chat", chatBody("openai", "gpt-4", "hello"))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusBadGateway {
		t.Errorf("got %d, want 502", w.Code)
	}
}

func TestChatReturns200WithResponseOnSuccess(t *testing.T) {
	t.Parallel()
	client := &fakeLLMClient{
		completionFn: func(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
			return &llm.ChatResponse{
				Content: "world",
				Model:   req.Model,
				Usage:   llm.TokenUsage{PromptTokens: 5, CompletionTokens: 3},
			}, nil
		},
	}
	h := newLLMHandler(&fakeLLMModelStore{}, registryWith(client))
	r := httptest.NewRequest(http.MethodPost, "/api/chat", chatBody("openai", "gpt-4", "hello"))
	w := httptest.NewRecorder()
	h.Chat(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["content"] != "world" {
		t.Errorf("content: got %v, want %q", resp["content"], "world")
	}
	if resp["provider"] != "openai" {
		t.Errorf("provider: got %v, want %q", resp["provider"], "openai")
	}
}
