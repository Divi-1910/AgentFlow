package model

import (
	"time"
	"backend/llm"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type MessageDocument struct {
	ID       bson.ObjectID `bson:"_id,omitempty" json:"id"`
	ThreadID bson.ObjectID `bson:"thread_id"     json:"thread_id"`
	AgentID  bson.ObjectID `bson:"agent_id"      json:"agent_id"`
	UserID   bson.ObjectID `bson:"user_id"       json:"user_id"`

	Role    string `bson:"role"    json:"role"`
	Content string `bson:"content" json:"content"`

	ToolCallID string `bson:"tool_call_id,omitempty" json:"tool_call_id,omitempty"`
	ToolCalls  []llm.ToolCall `bson:"tool_calls,omitempty" json:"tool_calls,omitempty"`

	ToolName string `bson:"tool_name,omitempty" json:"tool_name,omitempty"`

	Metadata map[string]any `bson:"metadata,omitempty" json:"metadata,omitempty"`

	CreatedAt time.Time `bson:"created_at" json:"created_at"`
}
