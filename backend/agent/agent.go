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

const defaultMaxSteps = 25

type Agent struct {
	ID   string
	Name string

	Provider string
	Model    string

	SystemPrompt string
	Tools        []string

	MaxSteps    int
	Temperature float64
	MaxTokens   int
}

type RunResult struct {
	Output   string
	Messages []llm.ChatMessage
	Steps    int
	Usage    llm.TokenUsage
}
