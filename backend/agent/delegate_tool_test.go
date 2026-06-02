package agent

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"backend/runtimectx"
	"backend/tools"
)

func delegationCtx() context.Context {
	return runtimectx.WithDelegation(context.Background(), runtimectx.DelegationInfo{
		OriginatorRunID: "orig-1",
		RunID:           "run-a",
		Chain:           []string{"agent-a"},
		Depth:           0,
		UserID:          "user-1",
	})
}

func TestDelegateTool_MissingDelegationContext(t *testing.T) {
	t.Parallel()
	dt := newDelegateTool(DelegateConfig{AgentID: "b", ToolName: "ask_b"}, &stubInvoker{})
	_, err := dt.Execute(context.Background(), tools.ToolCall{Args: json.RawMessage(`{"task":"hi"}`)})
	if err == nil {
		t.Fatal("want error when delegation context missing")
	}
}

func TestDelegateTool_InvalidJSON(t *testing.T) {
	t.Parallel()
	dt := newDelegateTool(DelegateConfig{AgentID: "b", ToolName: "ask_b"}, &stubInvoker{})
	res, err := dt.Execute(delegationCtx(), tools.ToolCall{Args: json.RawMessage(`{not json`)})
	if err != nil {
		t.Fatalf("Execute returned hard error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("want IsError result for invalid JSON, got %+v", res)
	}
}

func TestDelegateTool_BlankTask(t *testing.T) {
	t.Parallel()
	inv := &stubInvoker{}
	dt := newDelegateTool(DelegateConfig{AgentID: "b", ToolName: "ask_b"}, inv)
	res, err := dt.Execute(delegationCtx(), tools.ToolCall{Args: json.RawMessage(`{"task":"   "}`)})
	if err != nil {
		t.Fatalf("Execute returned hard error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("want IsError result for blank task, got %+v", res)
	}
	if inv.calledOnce {
		t.Fatal("invoker should not be called for a blank task")
	}
}

func TestDelegateTool_HappyPathForwardsToInvoker(t *testing.T) {
	t.Parallel()
	inv := &stubInvoker{out: "the answer"}
	dt := newDelegateTool(DelegateConfig{AgentID: "agent-b", ToolName: "ask_b"}, inv)
	res, err := dt.Execute(delegationCtx(), tools.ToolCall{Args: json.RawMessage(`{"task":"find X"}`)})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.IsError || res.Content != "the answer" {
		t.Fatalf("result = %+v, want content 'the answer'", res)
	}
	if inv.gotTarget != "agent-b" || inv.gotTask != "find X" {
		t.Fatalf("invoker got target=%q task=%q", inv.gotTarget, inv.gotTask)
	}
	if inv.gotParent.OriginatorRunID != "orig-1" || inv.gotParent.RunID != "run-a" {
		t.Fatalf("invoker parent delegation info wrong: %+v", inv.gotParent)
	}
}

func TestDelegateTool_InvokerErrorBecomesToolError(t *testing.T) {
	t.Parallel()
	inv := &stubInvoker{err: errors.New("boom")}
	dt := newDelegateTool(DelegateConfig{AgentID: "b", ToolName: "ask_b"}, inv)
	res, err := dt.Execute(delegationCtx(), tools.ToolCall{Args: json.RawMessage(`{"task":"x"}`)})
	if err != nil {
		t.Fatalf("Execute returned hard error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("want IsError result when invoker fails, got %+v", res)
	}
}

func TestDelegateTool_TimeoutInheritsParentContext(t *testing.T) {
	t.Parallel()
	dt := newDelegateTool(DelegateConfig{AgentID: "b", ToolName: "ask_b"}, &stubInvoker{})
	if dt.Timeout() != 0 {
		t.Fatalf("Timeout() = %v, want 0 (inherit parent ctx)", dt.Timeout())
	}
}
