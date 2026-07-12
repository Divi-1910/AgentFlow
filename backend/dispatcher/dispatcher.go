package dispatcher

import (
	"context"
	"log/slog"
	"time"

	"backend/agent"
	"backend/llm"
)

type Dispatcher interface {
	Dispatch(ctx context.Context, req DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error)
	EstimateSystemPromptTokens(ctx context.Context, req EstimateRequest) int
}

type DispatchRequest struct {
	RunID                 string
	AgentID               string
	UserID                string
	ThreadID              string
	Input                 string
	IsResume              bool
	Attempt               int
	Logger                *slog.Logger
	SystemContext         string
	InvocationKind        string
	JobID                 string
	PersistResultMessages bool

	// Delegation tree. For top-level runs these are left zero and defaulted
	// in the preparer (OriginatorRunID=RunID, Chain=[agentID], Depth=0). For
	// delegated runs the invoker populates them.
	OriginatorRunID string
	ParentRunID     string
	Chain           []string
	Depth           int
}

type EstimateRequest struct {
	AgentID  string
	UserID   string
	ThreadID string
	Summary  string
}

type DispatchPayload struct {
	RunID                 string   `json:"run_id"`
	OriginatorRunID       string   `json:"originator_run_id"`
	ParentRunID           string   `json:"parent_run_id,omitempty"`
	AgentID               string   `json:"agent_id"`
	UserID                string   `json:"user_id"`
	ThreadID              string   `json:"thread_id"`
	Input                 string   `json:"input"`
	IsResume              bool     `json:"is_resume"`
	Attempt               int      `json:"attempt"`
	Chain                 []string `json:"chain,omitempty"`
	Depth                 int      `json:"depth,omitempty"`
	SystemContext         string   `json:"system_context,omitempty"`
	InvocationKind        string   `json:"invocation_kind,omitempty"`
	JobID                 string   `json:"job_id,omitempty"`
	PersistResultMessages bool     `json:"persist_result_messages,omitempty"`
}

type DispatchReply struct {
	Result *RunResultWire `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

type RunResultWire struct {
	Status      string            `json:"status,omitempty"`
	Output      string            `json:"output"`
	NewMessages []llm.ChatMessage `json:"new_messages"`
	Steps       int               `json:"steps"`
	Usage       llm.TokenUsage    `json:"usage"`
}

type Runtime interface {
	RunStream(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error)
	EstimateSystemPromptTokens(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext) int
}

// AgentReader is the read-only agent port the run/delegate path depends on:
// loading an agent to prepare or resume a run. The Studio's full read/write
// store lives in the handlers package; the runtime never needs agent writes,
// so depending on the reader keeps this package free of the repository layer.
type AgentReader interface {
	GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error)
	GetByIDSystem(ctx context.Context, agentID string) (*agent.Agent, error)
}

type ThreadStore interface {
	Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error)
	GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error)
	ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error)
	UpdateSummary(ctx context.Context, threadID, userID, summary string) error
	FindOrCreateSubThread(ctx context.Context, userID, originatorRunID, agentID string) (string, error)
}

// RunStore is the subset of the run repository the delegate invoker needs:
// creating child run documents and setting a terminal status on dispatch-level
// failure (the worker/runtime own status once RunStream is entered).
type RunStore interface {
	CreateChildRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID string) error
	UpdateStatus(ctx context.Context, runID, status, lastError string) error
}

type MessageStore interface {
	ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error)
	InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]agent.MessageRecord, error)
	ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error)
}

// CoordinatorJobStore is the JobCoordinator's job/lock port: claiming and
// dispatching queued jobs, expiring stale leases, and running queued
// callbacks. Its method set intersects WorkerJobStore on the terminal-write
// calls (MarkJobFailed/MarkJobCancelled/MarkCallbackFailed/MarkCallbackCancelled)
// — the coordinator calls them on lease-expiry or cancellation, fencing on the
// child/callback run id it observed in its own query; the worker calls the
// same methods on its own run's completion, fencing on the run id it just
// executed. One concrete store satisfies both ports.
//
// MarkJobDispatched, MarkJobSucceeded, MarkJobFailed, and MarkJobCancelled
// all return an applied bool alongside the error: a nil error does not mean
// the fenced write took effect (zero rows matched is not an error condition
// for either backend), so callers MUST check applied before treating the
// transition as real — in particular, before publishing a dispatch or
// notifying a parent run that a job reached a terminal state.
type CoordinatorJobStore interface {
	FindQueueCandidates(ctx context.Context, limit int) ([]agent.JobRecord, error)
	CountActiveForOriginator(ctx context.Context, originatorRunID string) (int64, error)
	FindExpiredRunningJobs(ctx context.Context, before time.Time, limit int) ([]agent.JobRecord, error)
	FindExpiredRunningCallbacks(ctx context.Context, before time.Time, limit int) ([]agent.JobRecord, error)
	HasRunningTargetJob(ctx context.Context, originatorRunID, targetAgentID, excludeJobID string) (bool, error)
	HasRunningCallback(ctx context.Context, parentThreadID, excludeJobID string) (bool, error)
	AcquireLock(ctx context.Context, lockType, lockKey, activeJobID, activeRunID, owner string, ttl time.Duration) (bool, error)
	ReleaseLock(ctx context.Context, lockKey, activeJobID, owner string) error
	ClaimJobStarting(ctx context.Context, jobID, owner string, lease time.Duration) (agent.JobRecord, bool, error)
	MarkJobDispatched(ctx context.Context, jobID, owner, childRunID, childThreadID string) (bool, error)
	// MarkClaimedJobFailed terminates a job BEFORE MarkJobDispatched has ever
	// succeeded for it — child_run_id is not yet persisted at that point, so
	// fencing on it (as MarkJobFailed does) can never match. Fences on the
	// claim owner instead, matching MarkJobDispatched's own fencing.
	MarkClaimedJobFailed(ctx context.Context, jobID, owner, errText string) (bool, error)
	MarkJobFailed(ctx context.Context, jobID, childRunID, errText string) (bool, error)
	MarkJobCancelled(ctx context.Context, jobID, childRunID, errText string) (bool, error)
	FindReadyWaitingRunIDs(ctx context.Context, limit int) ([]string, error)
	FindQueuedCallbacks(ctx context.Context, limit int) ([]agent.JobRecord, error)
	MarkCallbackRunning(ctx context.Context, jobID, callbackRunID, owner string, lease time.Duration) (bool, error)
	MarkCallbackFailed(ctx context.Context, jobID, callbackRunID, errText string) error
	MarkCallbackCancelled(ctx context.Context, jobID, callbackRunID, errText string) error
}

// WorkerJobStore is the pool worker's post-run bookkeeping port: marking a
// dispatched job/callback terminal after RunStream returns, and refreshing
// its lease while the run is in flight. Every write fences on the child or
// callback run id the worker just executed, so a zombie worker left over from
// a lease-expired, already-reclaimed dispatch attempt can never clobber the
// attempt that superseded it. The job methods report whether the fenced
// write actually applied — callers must gate any parent-facing notification
// on that, not on a nil error alone.
type WorkerJobStore interface {
	MarkJobSucceeded(ctx context.Context, jobID, childRunID, output string) (bool, error)
	MarkJobFailed(ctx context.Context, jobID, childRunID, errText string) (bool, error)
	MarkJobCancelled(ctx context.Context, jobID, childRunID, errText string) (bool, error)
	MarkCallbackCompleted(ctx context.Context, jobID, callbackRunID string) error
	MarkCallbackFailed(ctx context.Context, jobID, callbackRunID, errText string) error
	MarkCallbackCancelled(ctx context.Context, jobID, callbackRunID, errText string) error
	RefreshJobLease(ctx context.Context, jobID, childRunID, originatorRunID, targetAgentID, owner string, ttl time.Duration) error
	RefreshCallbackLease(ctx context.Context, jobID, callbackRunID, parentThreadID, owner string, ttl time.Duration) error
}

// CoordinatorRunStore is the JobCoordinator's run-status port: creating
// tracked child/callback runs and driving their status through the
// waiting/running/terminal states as jobs are dispatched and resolved.
type CoordinatorRunStore interface {
	CreateChildRunWithKind(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error
	UpdateStatus(ctx context.Context, runID, status, lastError string) error
	TransitionStatus(ctx context.Context, runID string, from, to string) (bool, error)
	IncrementAttempt(ctx context.Context, runID string) (int, error)
	GetRun(ctx context.Context, runID string) (*agent.RunInfo, error)
}

// DurableCancelStore lets the pool worker and coordinator check/record task
// cancellation beyond the in-process CancelRegistry — e.g. a cancel issued
// while no worker for that agent is currently running.
type DurableCancelStore interface {
	IsCancelled(ctx context.Context, originatorRunID string) (bool, error)
	CancelTask(ctx context.Context, originatorRunID, reason string) error
}

type Summarizer interface {
	Summarize(ctx context.Context, ag *agent.Agent, existingSummary string, turns []agent.Turn) (string, llm.TokenUsage, error)
}

func payloadFromRequest(req DispatchRequest) DispatchPayload {
	originator := req.OriginatorRunID
	if originator == "" {
		originator = req.RunID
	}
	return DispatchPayload{
		RunID:                 req.RunID,
		OriginatorRunID:       originator,
		ParentRunID:           req.ParentRunID,
		AgentID:               req.AgentID,
		UserID:                req.UserID,
		ThreadID:              req.ThreadID,
		Input:                 req.Input,
		IsResume:              req.IsResume,
		Attempt:               req.Attempt,
		Chain:                 req.Chain,
		Depth:                 req.Depth,
		SystemContext:         req.SystemContext,
		InvocationKind:        req.InvocationKind,
		JobID:                 req.JobID,
		PersistResultMessages: req.PersistResultMessages,
	}
}

func requestFromPayload(payload DispatchPayload) DispatchRequest {
	logger := slog.With(
		"run_id", payload.RunID,
		"originator_run_id", payload.OriginatorRunID,
		"thread_id", payload.ThreadID,
		"user_id", payload.UserID,
		"agent_id", payload.AgentID,
	)
	return DispatchRequest{
		RunID:                 payload.RunID,
		OriginatorRunID:       payload.OriginatorRunID,
		ParentRunID:           payload.ParentRunID,
		AgentID:               payload.AgentID,
		UserID:                payload.UserID,
		ThreadID:              payload.ThreadID,
		Input:                 payload.Input,
		IsResume:              payload.IsResume,
		Attempt:               payload.Attempt,
		Chain:                 payload.Chain,
		Depth:                 payload.Depth,
		SystemContext:         payload.SystemContext,
		InvocationKind:        payload.InvocationKind,
		JobID:                 payload.JobID,
		PersistResultMessages: payload.PersistResultMessages,
		Logger:                logger,
	}
}

func wireFromRunResult(res *agent.RunResult) *RunResultWire {
	if res == nil {
		return nil
	}
	return &RunResultWire{
		Status:      string(res.Status),
		Output:      res.Output,
		NewMessages: res.NewMessages,
		Steps:       res.Steps,
		Usage:       res.Usage,
	}
}

func runResultFromWire(wire *RunResultWire) *agent.RunResult {
	if wire == nil {
		return nil
	}
	status := agent.RunResultStatus(wire.Status)
	if status == "" {
		status = agent.RunResultCompleted
	}
	return &agent.RunResult{
		Status:      status,
		Output:      wire.Output,
		NewMessages: wire.NewMessages,
		Steps:       wire.Steps,
		Usage:       wire.Usage,
	}
}
