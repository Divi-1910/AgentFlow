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
	DefaultMaxSteps         = 25
	DefaultContextWindow    = 6
	DefaultContextKeepRatio = 0.5
	DefaultTemperature      = 0.7
	DefaultMaxTokens        = 4096

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
	ModelContextLimit  int
	ContextWindow      int
	ContextKeepRatio   float64
	SummarizationModel string
	MaxSteps           int
	Temperature        float64
	MaxTokens          int
	CreatedAt          time.Time
}

type RunContext struct {
	RunID      string
	ThreadID   string
	Attempt    int
	Summary    string
	History    []llm.ChatMessage
	Input      string
	Checkpoint *RunSnapshot
	Memory     runtimectx.MemoryScope
	Logger     *slog.Logger

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
}

type RunResult struct {
	Output      string
	NewMessages []llm.ChatMessage
	Steps       int
	Usage       llm.TokenUsage
}
