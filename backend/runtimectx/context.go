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

type delegationKey struct{}

// DelegationInfo is the parent-run context a DelegateTool needs to spawn a
// child agent run: the root of the call tree, the current run (which becomes
// the child's parent), the agent-ID chain (for cycle detection), the current
// depth, and the owning user.
type DelegationInfo struct {
	OriginatorRunID string
	RunID           string
	Chain           []string
	Depth           int
	UserID          string
}

func WithDelegation(ctx context.Context, info DelegationInfo) context.Context {
	return context.WithValue(ctx, delegationKey{}, info)
}

func DelegationFromContext(ctx context.Context) (DelegationInfo, bool) {
	info, ok := ctx.Value(delegationKey{}).(DelegationInfo)
	return info, ok
}
