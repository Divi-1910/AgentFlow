package runtimectx

import "context"

type memoryScopeKey struct{}

type MemoryScope struct {
	UserID   string
	AgentID  string
	ThreadID string
}

func WithMemoryScope(ctx context.Context, scope MemoryScope) context.Context {
	return context.WithValue(ctx, memoryScopeKey{}, scope)
}

func MemoryScopeFromContext(ctx context.Context) (MemoryScope, bool) {
	scope, ok := ctx.Value(memoryScopeKey{}).(MemoryScope)
	return scope, ok
}
