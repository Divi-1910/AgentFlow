package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type RunStatus string

const (
	RunStatusRunning     RunStatus = "running"
	RunStatusCompleted   RunStatus = "completed"
	RunStatusFailed      RunStatus = "failed"
	RunStatusCancelled   RunStatus = "cancelled"   // RunStatusCancelled means the run was explicitly cancelled by the user. Distinct from RunStatusInterrupted, which is used when a run's context is cancelled (e.g. dropped SSE connection) but it can be resumed from the last checkpoint.
	RunStatusResumable   RunStatus = "resumable"   // RunStatusResumable means the run is currently running and has at least one checkpoint saved, so if the context is cancelled (e.g. dropped SSE connection) it can be resumed from the last checkpoint.
	RunStatusInterrupted RunStatus = "interrupted" // RunStatusInterrupted means the run was interrupted (e.g. dropped SSE connection) but it can be resumed from the last checkpoint if there is one, otherwise it will be marked as failed.
)

type RunDocument struct {
	ID             bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RunID          string        `bson:"run_id"        json:"run_id"`
	ThreadID       string        `bson:"thread_id"     json:"thread_id"`
	AgentID        string        `bson:"agent_id"      json:"agent_id"`
	UserID         string        `bson:"user_id"       json:"user_id"`
	Status         RunStatus     `bson:"status"          json:"status"`
	Attempt        int           `bson:"attempt"         json:"attempt"`
	StepsCompleted int           `bson:"steps_completed" json:"steps_completed"`
	LastError      string        `bson:"last_error,omitempty" json:"last_error,omitempty"`
	// Delegation lineage. OriginatorRunID is the root of the call tree (==
	// RunID for top-level runs); ParentRunID is the calling run ("" for
	// top-level). Set on child runs created via the delegate invoker.
	OriginatorRunID string    `bson:"originator_run_id,omitempty" json:"originator_run_id,omitempty"`
	ParentRunID     string    `bson:"parent_run_id,omitempty"     json:"parent_run_id,omitempty"`
	CreatedAt       time.Time `bson:"created_at" json:"created_at"`
	UpdatedAt       time.Time `bson:"updated_at" json:"updated_at"`
}

type RunCheckpointDocument struct {
	ID         bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RunID      string        `bson:"run_id"        json:"run_id"`
	Step       int           `bson:"step"  json:"step"`
	Phase      string        `bson:"phase" json:"phase"`
	SnapshotGZ []byte        `bson:"snapshot_gz" json:"-"`
	CreatedAt  time.Time     `bson:"created_at"           json:"created_at"`
	ExpiresAt  time.Time     `bson:"expires_at,omitempty" json:"expires_at,omitempty"`
}
