package repository

import (
	"context"
	"fmt"
	"time"

	"backend/agent"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type AgentRepo struct {
	col      *mongo.Collection
	modelCol *mongo.Collection
}

func NewAgentRepo(col, modelCol *mongo.Collection) *AgentRepo {
	return &AgentRepo{col: col, modelCol: modelCol}
}

func (r *AgentRepo) Create(ctx context.Context, userID string, input *agent.Agent) (*agent.Agent, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	now := time.Now()
	doc := model.AgentDocument{
		ID:                 bson.NewObjectID(),
		UserID:             uid,
		Name:               input.Name,
		Provider:           input.Provider,
		Model:              input.Model,
		SystemPrompt:       input.SystemPrompt,
		Tools:              input.Tools,
		ContextWindow:      input.ContextWindow,
		ContextKeepRatio:   input.ContextKeepRatio,
		SummarizationModel: input.SummarizationModel,
		MaxSteps:           input.MaxSteps,
		Temperature:        input.Temperature,
		MaxTokens:          input.MaxTokens,
		CreatedAt:          now,
		UpdatedAt:          now,
	}

	if doc.Tools == nil {
		doc.Tools = []string{}
	}

	if _, err := r.col.InsertOne(ctx, doc); err != nil {
		return nil, fmt.Errorf("agent_repo: insert failed: %w", err)
	}

	return r.toRuntimeAgent(ctx, doc), nil
}

func (r *AgentRepo) GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error) {
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	var doc model.AgentDocument
	err = r.col.FindOne(ctx, bson.M{"_id": aid, "user_id": uid}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, fmt.Errorf("agent not found")
	}
	if err != nil {
		return nil, fmt.Errorf("agent_repo: find failed: %w", err)
	}

	return r.toRuntimeAgent(ctx, doc), nil
}

func (r *AgentRepo) ListByUser(ctx context.Context, userID string) ([]*agent.Agent, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	cursor, err := r.col.Find(ctx, bson.M{"user_id": uid})
	if err != nil {
		return nil, fmt.Errorf("agent_repo: find failed: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []model.AgentDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("agent_repo: decode failed: %w", err)
	}

	agents := make([]*agent.Agent, len(docs))
	for i, doc := range docs {
		agents[i] = r.toRuntimeAgent(ctx, doc)
	}
	return agents, nil
}

func (r *AgentRepo) Delete(ctx context.Context, agentID, userID string) error {
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return fmt.Errorf("invalid user_id: %w", err)
	}

	result, err := r.col.DeleteOne(ctx, bson.M{"_id": aid, "user_id": uid})
	if err != nil {
		return fmt.Errorf("agent_repo: delete failed: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("agent not found")
	}
	return nil
}

func (r *AgentRepo) toRuntimeAgent(ctx context.Context, doc model.AgentDocument) *agent.Agent {
	return &agent.Agent{
		ID:                 doc.ID.Hex(),
		Name:               doc.Name,
		Provider:           doc.Provider,
		Model:              doc.Model,
		SystemPrompt:       doc.SystemPrompt,
		Tools:              doc.Tools,
		ModelContextLimit:  r.resolveContextLimit(ctx, doc.Provider, doc.Model),
		ContextWindow:      doc.ContextWindow,
		ContextKeepRatio:   doc.ContextKeepRatio,
		SummarizationModel: doc.SummarizationModel,
		MaxSteps:           doc.MaxSteps,
		Temperature:        doc.Temperature,
		MaxTokens:          doc.MaxTokens,
	}
}

func (r *AgentRepo) resolveContextLimit(ctx context.Context, provider, modelID string) int {
	var llmModel model.LLMModel
	err := r.modelCol.FindOne(ctx, bson.M{
		"provider":     provider,
		"api_model_id": modelID,
	}).Decode(&llmModel)

	if err == nil && llmModel.ContextWindow > 0 {
		return llmModel.ContextWindow
	}

	return agent.LookupContextLimit(modelID)
}
