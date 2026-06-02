package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type ThreadDocument struct {
	ID      bson.ObjectID `bson:"_id,omitempty" json:"id"`
	UserID  bson.ObjectID `bson:"user_id"       json:"user_id"`
	AgentID bson.ObjectID `bson:"agent_id"      json:"agent_id"`
	// Kind is "" for user-facing threads and "sub" for delegate sub-threads.
	// OriginatorRunID ties a sub-thread to the top-level run it belongs to;
	// together with (user_id, agent_id) it uniquely identifies a sub-thread.
	Kind            string         `bson:"kind,omitempty"             json:"kind,omitempty"`
	OriginatorRunID string         `bson:"originator_run_id,omitempty" json:"originator_run_id,omitempty"`
	Title           string         `bson:"title,omitempty"   json:"title,omitempty"`
	Summary         string         `bson:"summary,omitempty" json:"summary,omitempty"`
	Metadata        map[string]any `bson:"metadata,omitempty" json:"metadata,omitempty"`
	CreatedAt       time.Time      `bson:"created_at" json:"created_at"`
	UpdatedAt       time.Time      `bson:"updated_at" json:"updated_at"`
}
