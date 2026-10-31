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
// child agent run: the optional Team graph, root of the call tree, current run
// (which becomes the child's parent), agent-ID chain (for cycle detection),
// current depth, and owning user.
type DelegationInfo struct {
	TeamID          string
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
