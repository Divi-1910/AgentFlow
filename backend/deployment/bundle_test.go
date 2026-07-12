package deployment

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
