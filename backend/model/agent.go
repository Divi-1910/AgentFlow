package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type AgentDocument struct {
	ID     bson.ObjectID `bson:"_id,omitempty" json:"id"`
	UserID bson.ObjectID `bson:"user_id"       json:"user_id"`

	Name        string `bson:"name"                  json:"name"`
	Description string `bson:"description,omitempty" json:"description,omitempty"`

	Provider string `bson:"provider" json:"provider"`
	Model    string `bson:"model"    json:"model"`

	SystemPrompt string   `bson:"system_prompt" json:"system_prompt"`
	Tools        []string `bson:"tools"         json:"tools"`

	ContextWindow      int     `bson:"context_window,omitempty"      json:"context_window,omitempty"`
	ContextKeepRatio   float64 `bson:"context_keep_ratio,omitempty"  json:"context_keep_ratio,omitempty"`
	SummarizationModel string  `bson:"summarization_model,omitempty" json:"summarization_model,omitempty"`

	MaxSteps    int     `bson:"max_steps,omitempty"   json:"max_steps,omitempty"`
	Temperature float64 `bson:"temperature,omitempty" json:"temperature,omitempty"`
	MaxTokens   int     `bson:"max_tokens,omitempty"  json:"max_tokens,omitempty"`

	CreatedAt time.Time `bson:"created_at" json:"created_at"`
	UpdatedAt time.Time `bson:"updated_at" json:"updated_at"`
}
