package agent

import (
	"context"
	"time"
)

const (
	InvocationTopLevel     = "top_level"
	InvocationSyncDelegate = "sync_delegate"
	InvocationAsyncJob     = "async_job"
	InvocationCallback     = "callback"

	AsyncToolDispatchAgent = "dispatch_agent"
	AsyncToolAwaitJob      = "await_job"

	JobModeRequired   = "required"
	JobModeBackground = "background"

	DefaultCallbackInstruction = "Share the result with the user once the task finishes."
)

type RunResultStatus string

const (
	RunResultCompleted RunResultStatus = "completed"
	RunResultWaiting   RunResultStatus = "waiting_for_jobs"
)

type DispatchAgentRequest struct {
	ParentRunID         string
	OriginatorRunID     string
	ParentThreadID      string
	ParentAgentID       string
	UserID              string
	ToolCallID          string
	DelegateTool        string
	TargetAgentID       string
	Task                string
	Mode                string
	CallbackInstruction string
	DelegationChain     []string
	DelegationDepth     int
}

type DispatchAgentResult struct {
	JobID        string
	Status       string
	Mode         string
	DelegateTool string
}

type AwaitJobRequest struct {
	RunID           string
	OriginatorRunID string
	UserID          string
	JobID           string
	ToolCallID      string
}

type AwaitJobResult struct {
	JobID        string
	Status       string
	Output       string
	Error        string
	Pending      bool
	CreatedAt    time.Time
	DelegateTool string
}

type PendingAwait struct {
	JobID           string    `json:"job_id"`
	AwaitToolCallID string    `json:"await_tool_call_id"`
	CreatedAt       time.Time `json:"created_at"`
	Auto            bool      `json:"auto"`
	DelegateTool    string    `json:"delegate_tool,omitempty"`
}

type PendingRequiredJob struct {
	JobID        string
	CreatedAt    time.Time
	DelegateTool string
}

type AsyncJobStore interface {
	DispatchAgent(ctx context.Context, req DispatchAgentRequest) (DispatchAgentResult, error)
	AwaitJob(ctx context.Context, req AwaitJobRequest) (AwaitJobResult, error)
	PendingRequiredJobs(ctx context.Context, parentRunID, userID string) ([]PendingRequiredJob, error)
	MarkAwaiting(ctx context.Context, parentRunID string, awaits []PendingAwait) error
	ResolveAwaits(ctx context.Context, parentRunID, userID string, awaits []PendingAwait) ([]AwaitJobResult, bool, error)
	MarkDelivered(ctx context.Context, parentRunID, userID string, results []AwaitJobResult, awaits []PendingAwait) error
}
