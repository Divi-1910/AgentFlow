package tools

import (
	"backend/llm"
	"context"
	"encoding/json"
	"errors"
)

var (
	ErrToolNotFound        = errors.New("tool not found")
	ErrInvalidArgs         = errors.New("invalid tool arguments")
	ErrToolExecutionFailed = errors.New("Tool Execution Failed")
	ErrToolTimeout         = errors.New("Tool Timeout")
)

type ToolCall struct {
	ID   string
	Args json.RawMessage
}

type Tool interface {
	Name() string
	Definition() llm.ToolDefinition
	Execute(ctx context.Context, call ToolCall) (*ToolResult, error)
}

type ToolResult struct {
	Content  string
	IsError  bool
	Metadata map[string]any
}
