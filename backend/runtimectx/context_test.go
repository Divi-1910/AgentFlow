package runtimectx_test

import (
	"context"
	"testing"

	"backend/runtimectx"
)

func TestWithMemoryScopeRoundTrip(t *testing.T) {
	t.Parallel()
	scope := runtimectx.MemoryScope{
		UserID:   "user-1",
		AgentID:  "agent-1",
		ThreadID: "thread-1",
	}

	ctx := runtimectx.WithMemoryScope(context.Background(), scope)
	got, ok := runtimectx.MemoryScopeFromContext(ctx)

	if !ok {
		t.Fatal("MemoryScopeFromContext: expected ok=true")
	}
	if got != scope {
		t.Errorf("got %+v, want %+v", got, scope)
	}
}

func TestMemoryScopeFromContextReturnsFalseWhenNotSet(t *testing.T) {
	t.Parallel()
	_, ok := runtimectx.MemoryScopeFromContext(context.Background())
	if ok {
		t.Error("expected ok=false for context without MemoryScope")
	}
}

func TestWithMemoryScopeDoesNotMutateParent(t *testing.T) {
	t.Parallel()
	parent := context.Background()
	runtimectx.WithMemoryScope(parent, runtimectx.MemoryScope{UserID: "u"})

	_, ok := runtimectx.MemoryScopeFromContext(parent)
	if ok {
		t.Error("parent context should not be modified by WithMemoryScope")
	}
}

func TestWithMemoryScopeChildOverridesParent(t *testing.T) {
	t.Parallel()
	first := runtimectx.MemoryScope{UserID: "original"}
	second := runtimectx.MemoryScope{UserID: "overridden"}

	ctx := runtimectx.WithMemoryScope(context.Background(), first)
	ctx = runtimectx.WithMemoryScope(ctx, second)

	got, _ := runtimectx.MemoryScopeFromContext(ctx)
	if got.UserID != "overridden" {
		t.Errorf("got %q, want %q", got.UserID, "overridden")
	}
}
