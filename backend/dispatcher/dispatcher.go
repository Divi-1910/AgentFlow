package dispatcher

import (
	"context"
	"log/slog"

	"backend/agent"
	"backend/llm"
	"backend/model"
	"backend/repository"
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

type AgentStore interface {
	Create(ctx context.Context, userID string, a *agent.Agent) (*agent.Agent, error)
	GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error)
	GetByIDSystem(ctx context.Context, agentID string) (*agent.Agent, error)
	ListByUser(ctx context.Context, userID string) ([]*agent.Agent, error)
	Update(ctx context.Context, agentID, userID string, input repository.UpdateAgentInput) (*agent.Agent, error)
	Delete(ctx context.Context, agentID, userID string) error
}

type ThreadStore interface {
	Create(ctx context.Context, userID, agentID, title string) (*model.ThreadDocument, error)
	GetByID(ctx context.Context, threadID, userID string) (*model.ThreadDocument, error)
	ListByAgent(ctx context.Context, agentID, userID string) ([]*model.ThreadDocument, error)
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
	InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]model.MessageDocument, error)
	ListDocsByThread(ctx context.Context, threadID string, limit int) ([]model.MessageDocument, error)
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
