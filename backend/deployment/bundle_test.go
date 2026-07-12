package deployment

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/tools"
)

func validBundle() Bundle {
	return Bundle{
		SchemaVersion: SchemaVersion,
		DeploymentID:  "deployment-test",
		RootAgentID:   "supervisor",
		PlatformXML:   "<platform>test</platform>",
		Agents: []BundleAgent{{
			ID: "supervisor", Name: "Supervisor", Provider: "openai", Model: "test-model", SystemPrompt: "supervise",
			Tools: []string{}, Delegates: []BundleDelegate{}, MCPServers: []BundleMCPServer{},
			ModelContextLimit: 1000, ContextWindow: 6, ContextKeepRatio: 0.5,
			MaxSteps: 25, Temperature: 0.7, MaxTokens: 100, MaxRuns: 10,
		}},
	}
}

type fakeLLM struct{}

func (fakeLLM) ChatCompletion(context.Context, *llm.ChatRequest) (*llm.ChatResponse, error) {
	return &llm.ChatResponse{}, nil
}

func writeBundle(t *testing.T, value any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "deployment.json")
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadVerifiesCanonicalHash(t *testing.T) {
	b := validBundle()
	hash, err := b.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	b.ConfigHash = hash
	loaded, err := Load(writeBundle(t, b))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SyntheticUserID() != "runtime_"+hash[:32] {
		t.Fatalf("synthetic user = %q", loaded.SyntheticUserID())
	}
	loaded.PlatformXML += "changed"
	if err := loaded.VerifyHash(); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("VerifyHash after mutation = %v", err)
	}
}

func TestParseVerifiesExactBundleBytes(t *testing.T) {
	b := validBundle()
	hash, _ := b.CanonicalHash()
	b.ConfigHash = hash
	raw, _ := json.Marshal(b)
	parsed, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ConfigHash != hash {
		t.Fatalf("hash = %q, want %q", parsed.ConfigHash, hash)
	}
	if _, err := Parse(append(raw, []byte(`{}`)...)); err == nil {
		t.Fatal("Parse accepted trailing JSON")
	}
}

func TestBundleAgentFromAgentFreezesEffectiveValues(t *testing.T) {
	source := &agent.Agent{
		ID: "a", Name: "Agent", Provider: "openai", Model: "unknown-model", SystemPrompt: "prompt",
		Tools: nil, Delegates: nil, MCPServers: nil,
	}
	frozen, err := BundleAgentFromAgent(source)
	if err != nil {
		t.Fatal(err)
	}
	if frozen.ModelContextLimit != agent.LookupContextLimit(source.Model) ||
		frozen.ContextWindow != agent.DefaultContextWindow ||
		frozen.ContextKeepRatio != agent.DefaultContextKeepRatio ||
		frozen.SummarizationModel != source.Model ||
		frozen.MaxSteps != agent.DefaultMaxSteps ||
		frozen.Temperature != agent.DefaultTemperature ||
		frozen.MaxTokens != agent.DefaultMaxTokens ||
		frozen.MaxRuns != agent.DefaultMaxTaskRuns {
		t.Fatalf("defaults not frozen: %+v", frozen)
	}
	if frozen.Tools == nil || frozen.Delegates == nil || frozen.MCPServers == nil {
		t.Fatalf("nil slices were not normalized: %+v", frozen)
	}
}

func TestBundleAgentFromAgentPreservesResolvedContextAndCopies(t *testing.T) {
	source := &agent.Agent{
		ID: "a", Name: "Agent", Provider: "openai", Model: "gpt-4o", SystemPrompt: "prompt",
		Tools: []string{"calculator"}, Delegates: []agent.DelegateConfig{{AgentID: "b", ToolName: "ask_b"}},
		MCPServers:        []agent.MCPServerConfig{{Alias: "docs", URL: "https://docs.example/mcp", BearerEnv: "DOCS_TOKEN"}},
		ModelContextLimit: 128000, ContextWindow: 3, ContextKeepRatio: .25, SummarizationModel: "summary-model",
		MaxSteps: 9, Temperature: .2, MaxTokens: 777, MaxRuns: 4,
	}
	frozen, err := BundleAgentFromAgent(source)
	if err != nil {
		t.Fatal(err)
	}
	if frozen.ModelContextLimit != 128000 || frozen.ContextWindow != 3 || frozen.MaxRuns != 4 {
		t.Fatalf("resolved values changed: %+v", frozen)
	}
	source.Tools[0] = "mutated"
	source.Delegates[0].ToolName = "mutated"
	source.MCPServers[0].Alias = "mutated"
	if frozen.Tools[0] != "calculator" || frozen.Delegates[0].ToolName != "ask_b" || frozen.MCPServers[0].Alias != "docs" {
		t.Fatalf("conversion retained source slices: %+v", frozen)
	}
	roundTrip := frozen.Agent()
	if roundTrip.ModelContextLimit != 128000 || roundTrip.SummarizationModel != "summary-model" {
		t.Fatalf("inverse conversion lost values: %+v", roundTrip)
	}
}

func TestBundleAgentFromAgentPreservesInvalidNegativeValues(t *testing.T) {
	source := &agent.Agent{ID: "a", Name: "A", Provider: "openai", Model: "m", SystemPrompt: "p", ContextWindow: -1, ContextKeepRatio: -1, MaxSteps: -1, Temperature: -1, MaxTokens: -1}
	frozen, err := BundleAgentFromAgent(source)
	if err != nil {
		t.Fatal(err)
	}
	b := validBundle()
	b.RootAgentID, b.DeploymentID, b.Agents = "a", "a", []BundleAgent{frozen}
	if err := b.ValidateStatic(); err == nil {
		t.Fatal("invalid negative values were silently repaired")
	}
}

func TestCanonicalHashIgnoresJSONFormatting(t *testing.T) {
	b := validBundle()
	hash, _ := b.CanonicalHash()
	b.ConfigHash = hash
	compact, _ := json.Marshal(b)
	var generic map[string]any
	if err := json.Unmarshal(compact, &generic); err != nil {
		t.Fatal(err)
	}
	pretty, _ := json.MarshalIndent(generic, "", "  ")
	path := filepath.Join(t.TempDir(), "pretty.json")
	if err := os.WriteFile(path, pretty, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := loaded.CanonicalHash()
	if got != hash {
		t.Fatalf("hash = %s, want %s", got, hash)
	}
}

func TestCanonicalHashIncludesDeploymentID(t *testing.T) {
	b := validBundle()
	before, err := b.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	b.DeploymentID = "deployment-other"
	after, err := b.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("changing deployment_id did not change the canonical hash")
	}
}

func TestStudioOnlyEditsDoNotChangeHash(t *testing.T) {
	source := &agent.Agent{
		ID: "supervisor", Name: "Supervisor", Provider: "openai", Model: "gpt-4o", SystemPrompt: "prompt",
		ModelContextLimit: 128000, ContextWindow: 6, ContextKeepRatio: .5,
		MaxSteps: 25, Temperature: .7, MaxTokens: 100, MaxRuns: 10,
		CreatedAt: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	first, err := BundleAgentFromAgent(source)
	if err != nil {
		t.Fatal(err)
	}
	source.CreatedAt = time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	second, err := BundleAgentFromAgent(source)
	if err != nil {
		t.Fatal(err)
	}
	bundle := validBundle()
	bundle.Agents = []BundleAgent{first}
	firstHash, _ := bundle.CanonicalHash()
	bundle.Agents = []BundleAgent{second}
	secondHash, _ := bundle.CanonicalHash()
	if firstHash != secondHash {
		t.Fatalf("Studio-only CreatedAt edit changed hash: %s != %s", firstHash, secondHash)
	}
}

func TestReadRejectsUnknownAndTrailingJSON(t *testing.T) {
	b := validBundle()
	data, _ := json.Marshal(b)
	cases := []string{
		strings.Replace(string(data), `"schema_version":1`, `"schema_version":1,"unknown":true`, 1),
		string(data) + `{}`,
	}
	for _, body := range cases {
		path := filepath.Join(t.TempDir(), "invalid.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Read(path); err == nil {
			t.Fatalf("Read accepted %s", body)
		}
	}
}

func TestValidateStaticRejectsGraphErrors(t *testing.T) {
	t.Run("duplicate agent", func(t *testing.T) {
		b := validBundle()
		b.Agents = append(b.Agents, b.Agents[0])
		if err := b.ValidateStatic(); err == nil || !strings.Contains(err.Error(), "duplicate agent") {
			t.Fatalf("ValidateStatic = %v", err)
		}
	})
	t.Run("missing delegate", func(t *testing.T) {
		b := validBundle()
		b.Agents[0].Delegates = []BundleDelegate{{AgentID: "missing", ToolName: "research"}}
		if err := b.ValidateStatic(); err == nil || !strings.Contains(err.Error(), "missing agent") {
			t.Fatalf("ValidateStatic = %v", err)
		}
	})
	t.Run("unreachable agent", func(t *testing.T) {
		b := validBundle()
		orphan := b.Agents[0]
		orphan.ID = "orphan"
		orphan.Name = "Orphan"
		b.Agents = append(b.Agents, orphan)
		if err := b.ValidateStatic(); err == nil || !strings.Contains(err.Error(), "unreachable") {
			t.Fatalf("ValidateStatic = %v", err)
		}
	})
	t.Run("cycle", func(t *testing.T) {
		b := validBundle()
		b.Agents[0].Delegates = []BundleDelegate{{AgentID: "researcher", ToolName: "research"}}
		b.Agents = append(b.Agents, BundleAgent{
			ID: "researcher", Name: "Researcher", Provider: "openai", Model: "test", SystemPrompt: "research",
			Tools: []string{}, Delegates: []BundleDelegate{{AgentID: "supervisor", ToolName: "return_to_supervisor"}}, MCPServers: []BundleMCPServer{},
			ModelContextLimit: 1000, ContextWindow: 6, ContextKeepRatio: .5, MaxSteps: 10, MaxTokens: 100, MaxRuns: 10,
		})
		if err := b.ValidateStatic(); err == nil || !strings.Contains(err.Error(), "cycle") {
			t.Fatalf("ValidateStatic = %v", err)
		}
	})
}

func TestAgentReaderScopesAndDefensiveCopies(t *testing.T) {
	b := validBundle()
	r := NewAgentReader(&b, "runtime_user")
	if _, err := r.GetByID(context.Background(), "supervisor", "other"); err == nil {
		t.Fatal("cross-owner read succeeded")
	}
	a, err := r.GetByID(context.Background(), "supervisor", "runtime_user")
	if err != nil {
		t.Fatal(err)
	}
	a.Tools = append(a.Tools, "mutated")
	again, _ := r.GetByIDSystem(context.Background(), "supervisor")
	if len(again.Tools) != 0 {
		t.Fatalf("reader leaked mutation: %#v", again.Tools)
	}
}

func TestValidateEnvironmentRequiresMCPBearer(t *testing.T) {
	b := validBundle()
	b.Agents[0].MCPServers = []BundleMCPServer{{Alias: "context7", URL: "https://example.invalid/mcp", BearerEnv: "CONTEXT7_TOKEN"}}
	if err := b.ValidateEnvironment(func(string) (string, bool) { return "", false }); err == nil || !strings.Contains(err.Error(), "CONTEXT7_TOKEN") {
		t.Fatalf("ValidateEnvironment = %v", err)
	}
}

func TestValidateEnvironmentRejectsHTTPMCP(t *testing.T) {
	b := validBundle()
	b.Agents[0].MCPServers = []BundleMCPServer{{Alias: "context7", URL: "http://8.8.8.8/mcp"}}
	if err := b.ValidateEnvironment(func(string) (string, bool) { return "", false }); err == nil || !strings.Contains(err.Error(), "must be https") {
		t.Fatalf("ValidateEnvironment = %v", err)
	}
}

func TestValidateEnvironmentAllowsExplicitNoAuthMCP(t *testing.T) {
	b := validBundle()
	b.Agents[0].MCPServers = []BundleMCPServer{{Alias: "context7", URL: "https://mcp.example.test"}}
	lookupCalled := false
	validatedURL := ""
	err := b.ValidateEnvironmentWith(
		func(string) (string, bool) { lookupCalled = true; return "", false },
		func(rawURL string) error { validatedURL = rawURL; return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if lookupCalled || validatedURL != "https://mcp.example.test" {
		t.Fatalf("lookupCalled=%v validatedURL=%q", lookupCalled, validatedURL)
	}
}

func TestValidateRuntimeRequiresProviderAndTools(t *testing.T) {
	b := validBundle()
	providers := llm.NewEmptyLLMRegistry()
	registry := tools.NewEmptyRegistry()
	capabilities := agent.ToolCapabilities{AsyncJobs: true}
	if err := b.ValidateRuntime(registry, providers, capabilities); err == nil || !strings.Contains(err.Error(), "provider") {
		t.Fatalf("missing provider error = %v", err)
	}
	providers.Register("openai", fakeLLM{})
	b.Agents[0].Tools = []string{"missing_tool"}
	if err := b.ValidateRuntime(registry, providers, capabilities); err == nil || !strings.Contains(err.Error(), "missing_tool") {
		t.Fatalf("missing tool error = %v", err)
	}
}

func TestValidateForPublicationUsesEnvironmentIndependentCatalog(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	b := validBundle()
	b.Agents[0].Tools = []string{"web_search"}
	if err := b.ValidateForPublication(tools.NewCatalogRegistry(), agent.ToolCapabilities{AsyncJobs: true}); err != nil {
		t.Fatalf("known conditional tool rejected: %v", err)
	}
	b.Agents[0].Tools = []string{"web_serach"}
	if err := b.ValidateForPublication(tools.NewCatalogRegistry(), agent.ToolCapabilities{AsyncJobs: true}); err == nil || !strings.Contains(err.Error(), "web_serach") {
		t.Fatalf("unknown tool error = %v", err)
	}
	b.Agents[0].Tools = []string{}
	b.Agents[0].Provider = "fake"
	if err := b.ValidateForPublication(tools.NewCatalogRegistry(), agent.ToolCapabilities{AsyncJobs: true}); err == nil || !strings.Contains(err.Error(), "unsupported provider") {
		t.Fatalf("unsupported provider error = %v", err)
	}
}
