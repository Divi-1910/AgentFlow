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
}

type RunResult struct {
	Output      string
	NewMessages []llm.ChatMessage
	Steps       int
	Usage       llm.TokenUsage
}
