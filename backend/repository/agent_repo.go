package repository

import (
	"context"
	"fmt"
	"time"

	"backend/agent"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
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
		Description:        input.Description,
		Provider:           input.Provider,
		Model:              input.Model,
		SystemPrompt:       input.SystemPrompt,
		Tools:              input.Tools,
		Delegates:          toDelegateConfigDocs(input.Delegates),
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

func (r *AgentRepo) GetByIDSystem(ctx context.Context, agentID string) (*agent.Agent, error) {
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}

	var doc model.AgentDocument
	err = r.col.FindOne(ctx, bson.M{"_id": aid}).Decode(&doc)
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

type UpdateAgentInput struct {
	Name               *string
	Description        *string
	SystemPrompt       *string
	Tools              *[]string
	Delegates          *[]agent.DelegateConfig
	Provider           *string
	Model              *string
	Temperature        *float64
	MaxSteps           *int
	MaxTokens          *int
	ContextKeepRatio   *float64
	SummarizationModel *string
}

func (r *AgentRepo) Update(ctx context.Context, agentID, userID string, input UpdateAgentInput) (*agent.Agent, error) {
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	set := bson.M{"updated_at": time.Now()}
	if input.Name != nil {
		set["name"] = *input.Name
	}
	if input.Description != nil {
		set["description"] = *input.Description
	}
	if input.SystemPrompt != nil {
		set["system_prompt"] = *input.SystemPrompt
	}
	if input.Tools != nil {
		set["tools"] = *input.Tools
	}
	if input.Delegates != nil {
		set["delegates"] = toDelegateConfigDocs(*input.Delegates)
	}
	if input.Provider != nil {
		set["provider"] = *input.Provider
	}
	if input.Model != nil {
		set["model"] = *input.Model
	}
	if input.Temperature != nil {
		set["temperature"] = *input.Temperature
	}
	if input.MaxSteps != nil {
		set["max_steps"] = *input.MaxSteps
	}
	if input.MaxTokens != nil {
		set["max_tokens"] = *input.MaxTokens
	}
	if input.ContextKeepRatio != nil {
		set["context_keep_ratio"] = *input.ContextKeepRatio
	}
	if input.SummarizationModel != nil {
		set["summarization_model"] = *input.SummarizationModel
	}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var doc model.AgentDocument
	err = r.col.FindOneAndUpdate(
		ctx,
		bson.M{"_id": aid, "user_id": uid},
		bson.M{"$set": set},
		opts,
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, fmt.Errorf("agent not found")
	}
	if err != nil {
		return nil, fmt.Errorf("agent_repo: update failed: %w", err)
	}

	return r.toRuntimeAgent(ctx, doc), nil
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
		Description:        doc.Description,
		Provider:           doc.Provider,
		Model:              doc.Model,
		SystemPrompt:       doc.SystemPrompt,
		Tools:              doc.Tools,
		Delegates:          toDelegateConfigs(doc.Delegates),
		ModelContextLimit:  r.resolveContextLimit(ctx, doc.Provider, doc.Model),
		ContextWindow:      doc.ContextWindow,
		ContextKeepRatio:   doc.ContextKeepRatio,
		SummarizationModel: doc.SummarizationModel,
		MaxSteps:           doc.MaxSteps,
		Temperature:        doc.Temperature,
		MaxTokens:          doc.MaxTokens,
		CreatedAt:          doc.CreatedAt,
	}
}

func toDelegateConfigDocs(in []agent.DelegateConfig) []model.DelegateConfigDoc {
	if len(in) == 0 {
		return nil
	}
	out := make([]model.DelegateConfigDoc, len(in))
	for i, d := range in {
		out[i] = model.DelegateConfigDoc{
			AgentID:      d.AgentID,
			ToolName:     d.ToolName,
			Description:  d.Description,
			Instructions: d.Instructions,
		}
	}
	return out
}

func toDelegateConfigs(in []model.DelegateConfigDoc) []agent.DelegateConfig {
	if len(in) == 0 {
		return nil
	}
	out := make([]agent.DelegateConfig, len(in))
	for i, d := range in {
		out[i] = agent.DelegateConfig{
			AgentID:      d.AgentID,
			ToolName:     d.ToolName,
			Description:  d.Description,
			Instructions: d.Instructions,
		}
	}
	return out
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
