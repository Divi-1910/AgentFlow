package tools

import (
	"backend/llm"
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrToolNotFound        = errors.New("tool not found")
	ErrInvalidArgs         = errors.New("invalid tool arguments")
	ErrToolExecutionFailed = errors.New("Tool Execution Failed")
	ErrToolTimeout         = errors.New("Tool Timeout")
)

type ToolCall struct {
	ID    string
	RunID string
	Args  json.RawMessage
}

type Tool interface {
	Name() string
	Definition() llm.ToolDefinition
	Execute(ctx context.Context, call ToolCall) (*ToolResult, error)
}

// TimeoutTool is an optional interface a Tool may implement to override the
// runtime's default per-call timeout. Return 0 to inherit the parent context
// with no extra wall-clock cap (used by delegate tools, whose duration is
// governed by the parent run + the bus request bound); return >0 for a custom
// timeout. Tools that don't implement it keep the runtime default.
type TimeoutTool interface {
	Timeout() time.Duration
}

type ToolResult struct {
	Content  string
	IsError  bool
	Metadata map[string]any
}
