package mongorepo_test

import (
	"context"
	"testing"

	"backend/model"
	"backend/repo/mongorepo"
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

	r := mongorepo.NewLLMModelRepo(c)
	models, err := r.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(models) != 2 {
		t.Errorf("expected 2 models, got %d", len(models))
	}
}

func TestLLMModelRepoListAllEmptyReturnsEmptySlice(t *testing.T) {
	r := mongorepo.NewLLMModelRepo(col(t, "llm_models"))
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

func TestLLMModelRepoExistsUsesProviderAndAPIModelID(t *testing.T) {
	c := col(t, "llm_models")
	ctx := context.Background()
	if _, err := c.InsertOne(ctx, model.LLMModel{
		ModelID: "display-id", Name: "GPT", Provider: "openai", APIModelID: "gpt-api-id",
	}); err != nil {
		t.Fatal(err)
	}
	repo := mongorepo.NewLLMModelRepo(c)

	exists, err := repo.Exists(ctx, "openai", "gpt-api-id")
	if err != nil || !exists {
		t.Fatalf("matching model: exists=%v err=%v", exists, err)
	}
	exists, err = repo.Exists(ctx, "anthropic", "gpt-api-id")
	if err != nil || exists {
		t.Fatalf("wrong provider: exists=%v err=%v", exists, err)
	}
	exists, err = repo.Exists(ctx, "openai", "display-id")
	if err != nil || exists {
		t.Fatalf("display model id must not match API model id: exists=%v err=%v", exists, err)
	}
}
