package mongorepo

import (
	"context"
	"fmt"

	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type LLMModelRepo struct {
	col *mongo.Collection
}

// Exists reports whether the Studio catalog contains the exact provider/API
// model pair accepted by the provider adapter. Product configuration stores
// APIModelID in Agent.Model, not the catalog's display-oriented ModelID.
func (r *LLMModelRepo) Exists(ctx context.Context, provider, apiModelID string) (bool, error) {
	count, err := r.col.CountDocuments(ctx, bson.M{
		"provider":     provider,
		"api_model_id": apiModelID,
	})
	if err != nil {
		return false, fmt.Errorf("llm_model_repo: existence check failed: %w", err)
	}
	return count > 0, nil
}

func NewLLMModelRepo(col *mongo.Collection) *LLMModelRepo {
	return &LLMModelRepo{col: col}
}

// ListAll returns all LLM model records. Never returns nil — empty slice on no results.
func (r *LLMModelRepo) ListAll(ctx context.Context) ([]model.LLMModel, error) {
	cursor, err := r.col.Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var models []model.LLMModel
	if err := cursor.All(ctx, &models); err != nil {
		return nil, err
	}
	if models == nil {
		models = []model.LLMModel{}
	}
	return models, nil
}
