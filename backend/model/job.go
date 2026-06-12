package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type JobStatus string

const (
	JobStatusQueued    JobStatus = "queued"
	JobStatusStarting  JobStatus = "starting"
	JobStatusRunning   JobStatus = "running"
	JobStatusSucceeded JobStatus = "succeeded"
	JobStatusFailed    JobStatus = "failed"
	JobStatusCancelled JobStatus = "cancelled"
)

type JobMode string

const (
	JobModeRequired   JobMode = "required"
	JobModeBackground JobMode = "background"
)

type CallbackStatus string

const (
	CallbackStatusNone      CallbackStatus = "none"
	CallbackStatusQueued    CallbackStatus = "queued"
	CallbackStatusRunning   CallbackStatus = "running"
	CallbackStatusCompleted CallbackStatus = "completed"
	CallbackStatusFailed    CallbackStatus = "failed"
	CallbackStatusCancelled CallbackStatus = "cancelled"
)

type JobDocument struct {
	ID bson.ObjectID `bson:"_id,omitempty" json:"id"`

	JobID           string `bson:"job_id"             json:"job_id"`
	ParentRunID     string `bson:"parent_run_id"      json:"parent_run_id"`
	OriginatorRunID string `bson:"originator_run_id"  json:"originator_run_id"`
	ParentThreadID  string `bson:"parent_thread_id"   json:"parent_thread_id"`
	ParentAgentID   string `bson:"parent_agent_id"    json:"parent_agent_id"`
	UserID          string `bson:"user_id"            json:"user_id"`

	ToolCallID          string   `bson:"tool_call_id"       json:"tool_call_id"`
	DelegateTool        string   `bson:"delegate_tool"      json:"delegate_tool"`
	TargetAgentID       string   `bson:"target_agent_id"    json:"target_agent_id"`
	Task                string   `bson:"task"               json:"task"`
	Mode                string   `bson:"mode"               json:"mode"`
	CallbackInstruction string   `bson:"callback_instruction,omitempty" json:"callback_instruction,omitempty"`
	DelegationChain     []string `bson:"delegation_chain,omitempty" json:"delegation_chain,omitempty"`
	DelegationDepth     int      `bson:"delegation_depth,omitempty" json:"delegation_depth,omitempty"`

	Status string `bson:"status" json:"status"`
	Output string `bson:"output,omitempty" json:"output,omitempty"`
	Error  string `bson:"error,omitempty"  json:"error,omitempty"`

	ChildRunID    string `bson:"child_run_id,omitempty"    json:"child_run_id,omitempty"`
	ChildThreadID string `bson:"child_thread_id,omitempty" json:"child_thread_id,omitempty"`

	AwaitingParentRunID string     `bson:"awaiting_parent_run_id,omitempty" json:"awaiting_parent_run_id,omitempty"`
	AwaitToolCallID     string     `bson:"await_tool_call_id,omitempty"     json:"await_tool_call_id,omitempty"`
	AwaitingSince       *time.Time `bson:"awaiting_since,omitempty"         json:"awaiting_since,omitempty"`
	DeliveredAt         *time.Time `bson:"delivered_at,omitempty"           json:"delivered_at,omitempty"`
	DeliveredToolCallID string     `bson:"delivered_tool_call_id,omitempty" json:"delivered_tool_call_id,omitempty"`

	CallbackStatus string `bson:"callback_status" json:"callback_status"`
	CallbackRunID  string `bson:"callback_run_id,omitempty" json:"callback_run_id,omitempty"`

	LeaseOwner     string     `bson:"lease_owner,omitempty"      json:"lease_owner,omitempty"`
	LeaseExpiresAt *time.Time `bson:"lease_expires_at,omitempty" json:"lease_expires_at,omitempty"`

	CreatedAt  time.Time `bson:"created_at"  json:"created_at"`
	UpdatedAt  time.Time `bson:"updated_at"  json:"updated_at"`
	StartedAt  time.Time `bson:"started_at,omitempty"  json:"started_at,omitempty"`
	FinishedAt time.Time `bson:"finished_at,omitempty" json:"finished_at,omitempty"`
}

type JobLockDocument struct {
	ID bson.ObjectID `bson:"_id,omitempty" json:"id"`

	LockKey        string    `bson:"lock_key"         json:"lock_key"`
	LockType       string    `bson:"lock_type"        json:"lock_type"`
	ActiveJobID    string    `bson:"active_job_id"    json:"active_job_id"`
	ActiveRunID    string    `bson:"active_run_id,omitempty" json:"active_run_id,omitempty"`
	LeaseOwner     string    `bson:"lease_owner"      json:"lease_owner"`
	LeaseExpiresAt time.Time `bson:"lease_expires_at" json:"lease_expires_at"`
	CreatedAt      time.Time `bson:"created_at"       json:"created_at"`
	UpdatedAt      time.Time `bson:"updated_at"       json:"updated_at"`
}

type TaskDocument struct {
	ID bson.ObjectID `bson:"_id,omitempty" json:"id"`

	OriginatorRunID string     `bson:"originator_run_id" json:"originator_run_id"`
	UserID          string     `bson:"user_id"           json:"user_id"`
	CancelledAt     *time.Time `bson:"cancelled_at,omitempty" json:"cancelled_at,omitempty"`
	CancelReason    string     `bson:"cancel_reason,omitempty" json:"cancel_reason,omitempty"`
	MaxRuns         int        `bson:"max_runs" json:"max_runs"`
	RunsUsed        int        `bson:"runs_used" json:"runs_used"`
	RunKeys         []string   `bson:"run_budget_keys,omitempty" json:"-"`
	CreatedAt       time.Time  `bson:"created_at" json:"created_at"`
	UpdatedAt       time.Time  `bson:"updated_at" json:"updated_at"`
}
