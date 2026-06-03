package agent

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"backend/runtimectx"
	"backend/tools"
)

type stubInvoker struct {
	out        string
	err        error
	gotTarget  string
	gotTask    string
	gotParent  runtimectx.DelegationInfo
	calledOnce bool
}

func (s *stubInvoker) InvokeDelegate(_ context.Context, parent runtimectx.DelegationInfo, target, task string) (string, error) {
	s.calledOnce = true
	s.gotTarget = target
	s.gotTask = task
	s.gotParent = parent
	return s.out, s.err
}

func toolsetTestRegistry() *tools.ToolRegistry {
	reg := tools.NewEmptyRegistry()
	reg.Register(tools.NewCalculatorTool())
	return reg
}

func TestBuildToolSet_IncludesDelegatesInDefinitionsAndLookup(t *testing.T) {
	t.Parallel()
	ag := &Agent{
		ID:    "agent-a",
		Tools: []string{"calculator"},
		Delegates: []DelegateConfig{
			{AgentID: "agent-b", ToolName: "ask_researcher", Description: "delegate research", Instructions: "use sparingly"},
		},
	}
	ts, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag)
	if err != nil {
		t.Fatalf("BuildToolSet: %v", err)
	}
	names := ts.Names()
	if len(names) != 2 || names[0] != "calculator" || names[1] != "ask_researcher" {
		t.Fatalf("Names() = %v, want [calculator ask_researcher]", names)
	}
	if _, ok := ts.Get("ask_researcher"); !ok {
		t.Fatal("Get(ask_researcher) not found")
	}
	var hasDelegate bool
	for _, d := range ts.Definitions() {
		if d.Name == "ask_researcher" && d.Instructions == "use sparingly" {
			hasDelegate = true
		}
	}
	if !hasDelegate {
		t.Fatal("delegate definition missing or missing instructions")
	}
	if target, ok := ts.DelegateTarget("ask_researcher"); !ok || target != "agent-b" {
		t.Fatalf("DelegateTarget(ask_researcher) = %q, %v; want agent-b, true", target, ok)
	}
	if target, ok := ts.DelegateTarget("calculator"); ok || target != "" {
		t.Fatalf("DelegateTarget(calculator) = %q, %v; want empty, false", target, ok)
	}
}

func TestBuildToolSet_NilInvokerWithDelegatesFails(t *testing.T) {
	t.Parallel()
	ag := &Agent{ID: "agent-a", Delegates: []DelegateConfig{{AgentID: "b", ToolName: "ask_b"}}}

	if _, err := BuildToolSet(toolsetTestRegistry(), nil, ag); !errors.Is(err, ErrToolConfig) {
		t.Fatalf("execution build with nil invoker: got %v, want ErrToolConfig", err)
	}
	if _, err := BuildToolSetForValidation(toolsetTestRegistry(), ag); err != nil {
		t.Fatalf("validation build with nil invoker should succeed, got %v", err)
	}
}

func TestBuildToolSet_CollisionDelegateVsRegistry(t *testing.T) {
	t.Parallel()
	ag := &Agent{
		ID:        "agent-a",
		Tools:     []string{"calculator"},
		Delegates: []DelegateConfig{{AgentID: "b", ToolName: "calculator"}},
	}
	if _, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag); !errors.Is(err, ErrToolConfig) {
		t.Fatalf("got %v, want ErrToolConfig for delegate-vs-tool collision", err)
	}
}

func TestBuildToolSet_CollisionDelegateVsGlobalRegistry(t *testing.T) {
	t.Parallel()
	// "calculator" is registered globally but NOT in ag.Tools — the delegate
	// must still be rejected so it can never shadow a registry tool.
	ag := &Agent{
		ID:        "agent-a",
		Delegates: []DelegateConfig{{AgentID: "b", ToolName: "calculator"}},
	}
	if _, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag); !errors.Is(err, ErrToolConfig) {
		t.Fatalf("got %v, want ErrToolConfig for delegate-vs-global-registry collision", err)
	}
}

func TestBuildToolSet_CollisionDelegateVsDelegate(t *testing.T) {
	t.Parallel()
	ag := &Agent{
		ID: "agent-a",
		Delegates: []DelegateConfig{
			{AgentID: "b", ToolName: "ask_x"},
			{AgentID: "c", ToolName: "ask_x"},
		},
	}
	if _, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag); !errors.Is(err, ErrToolConfig) {
		t.Fatalf("got %v, want ErrToolConfig for delegate-vs-delegate collision", err)
	}
}

func TestBuildToolSet_DuplicateTool(t *testing.T) {
	t.Parallel()
	ag := &Agent{ID: "agent-a", Tools: []string{"calculator", "calculator"}}
	if _, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag); !errors.Is(err, ErrToolConfig) {
		t.Fatalf("got %v, want ErrToolConfig for duplicate tool", err)
	}
}

func TestToolSet_StructHashTracksDelegateTarget(t *testing.T) {
	t.Parallel()
	mk := func(target string) ToolRef {
		ag := &Agent{ID: "agent-a", Delegates: []DelegateConfig{{AgentID: target, ToolName: "ask_x", Description: "d"}}}
		ts, err := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag)
		if err != nil {
			t.Fatalf("BuildToolSet: %v", err)
		}
		for _, r := range ts.Refs() {
			if r.Name == "ask_x" {
				return r
			}
		}
		t.Fatal("ask_x ref not found")
		return ToolRef{}
	}
	a := mk("agent-b")
	b := mk("agent-c")
	if a.StructHash == b.StructHash {
		t.Errorf("StructHash should differ when delegate target changes: %q == %q", a.StructHash, b.StructHash)
	}
}

func TestToolSet_CosmeticHashTracksDescriptionNotStructural(t *testing.T) {
	t.Parallel()
	mk := func(desc string) ToolRef {
		ag := &Agent{ID: "agent-a", Delegates: []DelegateConfig{{AgentID: "b", ToolName: "ask_x", Description: desc}}}
		ts, _ := BuildToolSet(toolsetTestRegistry(), &stubInvoker{}, ag)
		for _, r := range ts.Refs() {
			if r.Name == "ask_x" {
				return r
			}
		}
		return ToolRef{}
	}
	a := mk("first description")
	b := mk("second description")
	if a.StructHash != b.StructHash {
		t.Errorf("StructHash should NOT change on description-only change")
	}
	if a.CosmeticHash == b.CosmeticHash {
		t.Errorf("CosmeticHash should change on description change")
	}
}

func TestToolRefList_UnmarshalAcceptsBothShapes(t *testing.T) {
	t.Parallel()

	var legacy ToolRefList
	if err := json.Unmarshal([]byte(`["calculator","web_search"]`), &legacy); err != nil {
		t.Fatalf("legacy unmarshal: %v", err)
	}
	if len(legacy) != 2 || legacy[0].Name != "calculator" || legacy[0].StructHash != "" {
		t.Fatalf("legacy decode = %+v, want name-only refs", legacy)
	}

	var modern ToolRefList
	if err := json.Unmarshal([]byte(`[{"name":"calculator","struct_hash":"h1","cosmetic_hash":"c1"}]`), &modern); err != nil {
		t.Fatalf("modern unmarshal: %v", err)
	}
	if len(modern) != 1 || modern[0].StructHash != "h1" || modern[0].CosmeticHash != "c1" {
		t.Fatalf("modern decode = %+v", modern)
	}
}
