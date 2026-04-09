package tools

import (
	"backend/llm"
	"context"
	"encoding/json"
	"errors"
)

var (
	ErrToolNotFound        = errors.New("tool not found")
	ErrInvalidArgs         = errors.New("Invalide Tool Arguments")
	ErrToolExecutionFailed = errors.New("Tool Execution Failed")
	ErrToolTimeout         = errors.New("Tool Timeout")
)

type Tool interface {
	Name() string
	Definition() llm.ToolDefinition
	Execute(ctx context.Context, args json.RawMessage) (*ToolResult, error)
}

type ToolResult struct {
	Content  string
	IsError  bool
	Metadata map[string]any
}
