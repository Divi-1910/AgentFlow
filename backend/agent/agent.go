package agent

import (
	"errors"
	"log/slog"
	"time"

	"backend/llm"
	"backend/runtimectx"
)

var (
	ErrMaxStepsReached  = errors.New("agent exceeded max steps")
	ErrToolNotAvailable = errors.New("agent requested unavailable tool")
	ErrNoFinalOutput    = errors.New("agent stopped without producing output")
)

const (
	DefaultMaxSteps           = 25
	DefaultContextWindow      = 6
	DefaultContextKeepRatio   = 0.5
	DefaultTemperature        = 0.7
	DefaultMaxTokens          = 4096
	DefaultMaxDelegationDepth = 5

	contextTriggerRatio = 0.85
)

type Agent struct {
	ID                 string
	Name               string
	Description        string
	Provider           string
	Model              string
	SystemPrompt       string
	Tools              []string
	Delegates          []DelegateConfig
	MCPServers         []MCPServerConfig
	ModelContextLimit  int
	ContextWindow      int
	ContextKeepRatio   float64
	SummarizationModel string
	MaxSteps           int
	Temperature        float64
	MaxTokens          int
	MaxRuns            int
	CreatedAt          time.Time
}

// DelegateConfig declares another agent this agent may call as a tool. The
// runtime synthesizes a DelegateTool per entry; AgentID is the callee (owned
// by the same user), ToolName is what the LLM sees, Description/Instructions
// guide when and how to call it.
type DelegateConfig struct {
	AgentID      string
	ToolName     string
	Description  string
	Instructions string
}

// MCPServerConfig declares one remote MCP server this agent connects to. At run
// start the runtime discovers the server's tools (tools/list) and exposes them
// as mcp__<alias>__<tool>. Alias namespaces those tools; URL is the remote
// Streamable-HTTP endpoint; BearerEnv names an OS env var holding a static
// bearer token (empty for no-auth) — the token itself is never persisted.
type MCPServerConfig struct {
	Alias     string
	URL       string
	BearerEnv string
}

type RunContext struct {
	RunID         string
	ThreadID      string
	Attempt       int
	Summary       string
	History       []llm.ChatMessage
	Input         string
	SystemContext string
	Checkpoint    *RunSnapshot
	Memory        runtimectx.MemoryScope
	Logger        *slog.Logger

	// Phase reflects the runtime execution phase (PhasePreModel,
	// PhasePostModel, PhaseStepCompleted). Surfaced to the model inside
	// <context><state>.
	Phase string

	// LastAction is a short human-readable description of the most recent
	// tool execution outcome, e.g. "memory_write(id=user-tone) → success".
	// Surfaced to the model inside <context><state>.
	LastAction string

	// StepsCompleted is the number of agent loop steps completed before this
	// invocation. Zero for fresh runs; copied from the checkpoint snapshot
	// for resumes. Surfaced to the model inside <context><state>.
	StepsCompleted int

	// Delegation tree fields. For a top-level run, OriginatorRunID == RunID,
	// ParentRunID == "", DelegationChain == [agentID], DelegationDepth == 0.
	// For a delegated (child) run these are carried in from the dispatch
	// payload. OriginatorRunID keys the cancel topic/registry for the whole
	// tree; RunID keys the per-run event topic.
	OriginatorRunID string
	ParentRunID     string
	DelegationChain []string
	DelegationDepth int
	InvocationKind  string
	JobID           string

	// MCPUnavailable lists the aliases of MCP servers that failed discovery at
	// run start. The context builder renders these as a model-visible note so
	// the agent knows those tools are absent this run. Set by the runtime.
	MCPUnavailable []string
}

type RunResult struct {
	Status      RunResultStatus
	Output      string
	NewMessages []llm.ChatMessage
	Steps       int
	Usage       llm.TokenUsage
}
