package tools_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"backend/llm"
	"backend/memory"
	"backend/scratchpad"
	"backend/tools"
)

// ── fakeTool ──────────────────────────────────────────────────────────────────

type fakeTool struct {
	name string
}

func TestCatalogRegistryIncludesConditionalToolsWithoutEnvironment(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	catalog := tools.NewCatalogRegistry()
	for _, name := range []string{"calculator", "http_request", "web_search", "memory_write", "scratchpad_create"} {
		if !catalog.Has(name) {
			t.Fatalf("catalog missing %q", name)
		}
	}
	if tools.NewValidationRegistry().Has("web_search") {
		t.Fatal("boot validation registry included web_search without TAVILY_API_KEY")
	}
}

func TestCatalogDefinitionsMatchExecutableRegistry(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "test")
	catalog := tools.NewCatalogRegistry()
	executable := tools.NewToolRegistry(nil, &memory.Service{}, &scratchpad.Service{})
	definitionMap := func(reg *tools.ToolRegistry) map[string]json.RawMessage {
		out := make(map[string]json.RawMessage)
		for _, def := range reg.Definitions() {
			raw, err := json.Marshal(def)
			if err != nil {
				t.Fatal(err)
			}
			out[def.Name] = raw
		}
		return out
	}
	if !reflect.DeepEqual(definitionMap(catalog), definitionMap(executable)) {
		t.Fatal("catalog definitions drifted from executable definitions")
	}
}

func (f *fakeTool) Name() string { return f.name }

func (f *fakeTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{Name: f.name, Description: "fake tool " + f.name}
}

func (f *fakeTool) Execute(_ context.Context, _ tools.ToolCall) (*tools.ToolResult, error) {
	return &tools.ToolResult{Content: "fake result"}, nil
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

func TestNewEmptyRegistryHasNoTools(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	if names := r.Names(); len(names) != 0 {
		t.Errorf("expected 0 tools, got %d: %v", len(names), names)
	}
}

func TestRegisterAndHas(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	r.Register(&fakeTool{name: "mytool"})
	if !r.Has("mytool") {
		t.Error("Has: expected true after Register")
	}
	if r.Has("nonexistent") {
		t.Error("Has: expected false for unregistered tool")
	}
}

func TestGetReturnsRegisteredTool(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	ft := &fakeTool{name: "mytool"}
	r.Register(ft)

	got, err := r.Get("mytool")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != ft {
		t.Error("Get returned a different tool than what was registered")
	}
}

func TestGetReturnsErrToolNotFoundForMissingTool(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	_, err := r.Get("nonexistent")
	if err == nil {
		t.Fatal("expected error for unregistered tool")
	}
	if !errors.Is(err, tools.ErrToolNotFound) {
		t.Errorf("expected ErrToolNotFound, got: %v", err)
	}
}

func TestNamesReturnsAllRegisteredNames(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	r.Register(&fakeTool{name: "alpha"})
	r.Register(&fakeTool{name: "beta"})
	r.Register(&fakeTool{name: "gamma"})

	names := r.Names()
	if len(names) != 3 {
		t.Fatalf("expected 3 names, got %d: %v", len(names), names)
	}
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	for _, want := range []string{"alpha", "beta", "gamma"} {
		if !got[want] {
			t.Errorf("name %q missing from Names()", want)
		}
	}
}

func TestDefinitionsReturnsSortedDefinitions(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	r.Register(&fakeTool{name: "zebra"})
	r.Register(&fakeTool{name: "apple"})
	r.Register(&fakeTool{name: "mango"})

	defs := r.Definitions()
	if len(defs) != 3 {
		t.Fatalf("expected 3 definitions, got %d", len(defs))
	}
	// Definitions are sorted alphabetically.
	if defs[0].Name != "apple" || defs[1].Name != "mango" || defs[2].Name != "zebra" {
		t.Errorf("definitions not sorted: %v", []string{defs[0].Name, defs[1].Name, defs[2].Name})
	}
}

func TestRegisterOverwritesExistingTool(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	original := &fakeTool{name: "mytool"}
	replacement := &fakeTool{name: "mytool"}

	r.Register(original)
	r.Register(replacement)

	got, _ := r.Get("mytool")
	if got != replacement {
		t.Error("Register should overwrite existing tool with same name")
	}
	if len(r.Names()) != 1 {
		t.Errorf("expected 1 tool after overwrite, got %d", len(r.Names()))
	}
}

func TestRegistryWithRealCalculatorTool(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	r.Register(tools.NewCalculatorTool())

	if !r.Has("calculator") {
		t.Error("calculator tool should be registered")
	}
	tool, err := r.Get("calculator")
	if err != nil {
		t.Fatalf("Get calculator: %v", err)
	}
	if tool.Name() != "calculator" {
		t.Errorf("Name: got %q, want %q", tool.Name(), "calculator")
	}
}
