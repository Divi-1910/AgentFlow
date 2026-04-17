package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type RunStatus string

const (
	RunStatusRunning            RunStatus = "running"
	RunStatusCompleted          RunStatus = "completed"
	RunStatusFailed             RunStatus = "failed"
	RunStatusCancelled          RunStatus = "cancelled"
	RunStatusResumable          RunStatus = "resumable"
	RunStatusDegraded           RunStatus = "running_unprotected"
	RunStatusRequiresResolution RunStatus = "requires_manual_resolution"
)

// RunDocument tracks the lifecycle of a single agent execution.
type RunDocument struct {
	ID       bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RunID    string        `bson:"run_id"        json:"run_id"`
	ThreadID string        `bson:"thread_id"     json:"thread_id"`
	AgentID  string        `bson:"agent_id"      json:"agent_id"`
	UserID   string        `bson:"user_id"       json:"user_id"`

	Status         RunStatus `bson:"status"          json:"status"`
	Attempt        int       `bson:"attempt"         json:"attempt"`
	StepsCompleted int       `bson:"steps_completed" json:"steps_completed"`

	LastError string `bson:"last_error,omitempty" json:"last_error,omitempty"`

	CreatedAt time.Time `bson:"created_at" json:"created_at"`
	UpdatedAt time.Time `bson:"updated_at" json:"updated_at"`
}

// RunCheckpointDocument stores a durable snapshot at a step boundary.
type RunCheckpointDocument struct {
	ID    bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RunID string        `bson:"run_id"        json:"run_id"`

	Step  int    `bson:"step"  json:"step"`
	Phase string `bson:"phase" json:"phase"`

	// Compressed gzip of the serialized RunSnapshot JSON.
	SnapshotGZ []byte `bson:"snapshot_gz" json:"-"`

	CreatedAt time.Time `bson:"created_at"           json:"created_at"`
	ExpiresAt time.Time `bson:"expires_at,omitempty" json:"expires_at,omitempty"`
}
