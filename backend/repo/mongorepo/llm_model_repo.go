package mongorepo

import (
	"context"

	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type LLMModelRepo struct {
	col *mongo.Collection
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
