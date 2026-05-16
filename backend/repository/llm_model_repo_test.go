package repository_test

import (
	"context"
	"testing"

	"backend/model"
	"backend/repository"
)

func TestLLMModelRepoListAll(t *testing.T) {
	c := col(t, "llm_models")
	ctx := context.Background()

	// Seed two models directly into the collection.
	docs := []interface{}{
		model.LLMModel{ModelID: "gpt-4o", Name: "GPT-4o", Provider: "openai", APIModelID: "gpt-4o", ContextWindow: 128000},
		model.LLMModel{ModelID: "claude-3", Name: "Claude 3 Opus", Provider: "anthropic", APIModelID: "claude-3-opus-20240229", ContextWindow: 200000},
	}
	if _, err := c.InsertMany(ctx, docs); err != nil {
		t.Fatalf("seed InsertMany: %v", err)
	}

	r := repository.NewLLMModelRepo(c)
	models, err := r.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(models) != 2 {
		t.Errorf("expected 2 models, got %d", len(models))
	}
}

func TestLLMModelRepoListAllEmptyReturnsEmptySlice(t *testing.T) {
	r := repository.NewLLMModelRepo(col(t, "llm_models"))
	ctx := context.Background()

	models, err := r.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if models == nil {
		t.Error("ListAll: expected non-nil empty slice, got nil")
	}
	if len(models) != 0 {
		t.Errorf("ListAll: expected 0 models, got %d", len(models))
	}
}
