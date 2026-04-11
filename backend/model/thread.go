package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type ThreadDocument struct {
	ID      bson.ObjectID `bson:"_id,omitempty" json:"id"`
	UserID  bson.ObjectID `bson:"user_id"       json:"user_id"`
	AgentID bson.ObjectID `bson:"agent_id"      json:"agent_id"`

	Title string `bson:"title,omitempty" json:"title,omitempty"`

	Summary string `bson:"summary,omitempty" json:"summary,omitempty"`

	Metadata map[string]any `bson:"metadata,omitempty" json:"metadata,omitempty"`

	CreatedAt time.Time `bson:"created_at" json:"created_at"`
	UpdatedAt time.Time `bson:"updated_at" json:"updated_at"`
}
