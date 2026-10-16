package deployment

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestPlanRuntimeCredentialsScansCompleteAgentGraph(t *testing.T) {
	t.Parallel()
	bundle := runtimeCredentialTestBundle()

	plan, err := PlanRuntimeCredentials(bundle)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TAVILY_API_KEY"}
	if !reflect.DeepEqual(plan.EnvNames, want) {
		t.Fatalf("credential plan = %v, want %v", plan.EnvNames, want)
	}

	plan.EnvNames[0] = "MUTATED"
	again, err := PlanRuntimeCredentials(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(again.EnvNames, plan.EnvNames) {
		t.Fatal("credential plan reused caller-mutable storage")
	}
}

func TestPlanRuntimeCredentialsRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	if _, err := PlanRuntimeCredentials(nil); err == nil {
		t.Fatal("nil bundle was accepted")
	}

	bundle := runtimeCredentialTestBundle()
	bundle.Agents[0].Provider = "unsupported"
	if _, err := PlanRuntimeCredentials(bundle); err == nil || !strings.Contains(err.Error(), "unsupported provider") {
		t.Fatalf("unsupported provider error = %v", err)
	}
}

func TestRuntimeAPITokenGenerationAndValidation(t *testing.T) {
	t.Parallel()
	random := strings.NewReader(strings.Repeat("x", runtimeAPITokenEntropy))
	token, err := newRuntimeAPIToken(random)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, runtimeAPITokenPrefix) {
		t.Fatalf("token = %q, want prefix %q", token, runtimeAPITokenPrefix)
	}
	if err := ValidateRuntimeAPIToken(token); err != nil {
		t.Fatalf("generated token rejected: %v", err)
	}

	for _, invalid := range []string{"", " token", "afrt_short", token + "="} {
		if err := ValidateRuntimeAPIToken(invalid); err == nil {
			t.Fatalf("invalid token %q was accepted", invalid)
		}
	}
}

func TestRuntimeAPITokenGenerationPropagatesEntropyFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("entropy unavailable")
	if _, err := newRuntimeAPIToken(errorReader{err: want}); !errors.Is(err, want) {
		t.Fatalf("generation error = %v, want wrapped %v", err, want)
	}
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

func runtimeCredentialTestBundle() *Bundle {
	return &Bundle{
		SchemaVersion: SchemaVersion,
		DeploymentID:  "deployment-1",
		RootAgentID:   "root",
		PlatformXML:   "<platform />",
		Agents: []BundleAgent{
			{
				ID: "root", Name: "Root", Provider: "openai", Model: "gpt-4o", SystemPrompt: "coordinate",
				Tools:             []string{"calculator", "web_search"},
				Delegates:         []BundleDelegate{{AgentID: "researcher", ToolName: "researcher"}},
				MCPServers:        []BundleMCPServer{{ServerID: "fetch", Alias: "fetch", URL: "http://fetch.mcp.svc.cluster.local/mcp"}},
				ModelContextLimit: 128000, ContextWindow: 4000, ContextKeepRatio: 0.5,
				MaxSteps: 8, MaxTokens: 1000, MaxRuns: 8,
			},
			{
				ID: "researcher", Name: "Researcher", Provider: "anthropic", Model: "claude", SystemPrompt: "research",
				Tools:             []string{"http_request", "web_search"},
				ModelContextLimit: 128000, ContextWindow: 4000, ContextKeepRatio: 0.5,
				MaxSteps: 8, MaxTokens: 1000, MaxRuns: 8,
			},
		},
	}
}
