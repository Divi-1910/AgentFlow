package agent

import (
	"errors"

	"backend/llm"
)

var (
	ErrMaxStepsReached  = errors.New("agent exceeded max steps")
	ErrToolNotAvailable = errors.New("agent requested unavailable tool")
	ErrNoFinalOutput    = errors.New("agent stopped without producing output")
)

const (
	defaultMaxSteps         = 25
	defaultContextWindow    = 6
	defaultContextKeepRatio = 0.5
	contextTriggerRatio     = 0.95
)

type Agent struct {
	ID   string
	Name string

	Provider string
	Model    string

	SystemPrompt string
	Tools        []string

	ModelContextLimit  int
	ContextWindow      int
	ContextKeepRatio   float64
	SummarizationModel string

	MaxSteps    int
	Temperature float64
	MaxTokens   int
}

type RunContext struct {
	Summary string
	History []llm.ChatMessage
	Input   string
}

type RunResult struct {
	Output      string
	NewMessages []llm.ChatMessage
	Steps       int
	Usage       llm.TokenUsage
}
