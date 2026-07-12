package mongorepo_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"backend/agent"
	"backend/deployment"
	"backend/model"
	"backend/publisher"
	"backend/repo/mongorepo"
	"backend/tools"
)

func TestPublisherRoundTripThroughRuntimeBundleLoader(t *testing.T) {
	ctx := context.Background()
	agentsCol := col(t, "publisher_agents")
	modelsCol := col(t, "publisher_models")
	revisionsCol := col(t, "publisher_revisions")
	if _, err := modelsCol.InsertOne(ctx, model.LLMModel{
		ModelID: "catalog-gpt4o", Name: "GPT-4o", Provider: "openai", APIModelID: "gpt-4o", ContextWindow: 128000,
	}); err != nil {
		t.Fatal(err)
	}
	agents := mongorepo.NewAgentRepo(agentsCol, modelsCol)
	child, err := agents.Create(ctx, userA, &agent.Agent{
		Name: "Researcher", Provider: "openai", Model: "gpt-4o", SystemPrompt: "research",
	})
	if err != nil {
		t.Fatal(err)
	}
	root, err := agents.Create(ctx, userA, &agent.Agent{
		Name: "Supervisor", Provider: "openai", Model: "gpt-4o", SystemPrompt: "supervise",
		Tools:      []string{"web_search"},
		Delegates:  []agent.DelegateConfig{{AgentID: child.ID, ToolName: "ask_researcher", Description: "research"}},
		MCPServers: []agent.MCPServerConfig{{Alias: "context7", URL: "https://context7.example/mcp", BearerEnv: "CONTEXT7_TOKEN"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	revisions := mongorepo.NewDeploymentRevisionRepo(revisionsCol)
	if err := revisions.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	svc, err := publisher.NewService(publisher.Config{
		Agents: agents, Revisions: revisions, Platform: &agent.PlatformConfig{Body: "<platform>published</platform>"},
		Catalog: tools.NewCatalogRegistry(),
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := svc.Publish(ctx, userA, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Publish(ctx, userA, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.WasExisting || !second.WasExisting || first.Revision.Revision != second.Revision.Revision {
		t.Fatalf("first/second = %+v/%+v", first, second)
	}
	stored, err := svc.GetBundle(ctx, userA, root.ID, first.Revision.Revision)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "deployment.json")
	if err := os.WriteFile(path, stored.BundleJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	bundle, err := deployment.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.DeploymentID != root.ID || bundle.RootAgentID != root.ID || bundle.PlatformXML != "<platform>published</platform>" || len(bundle.Agents) != 2 {
		t.Fatalf("bundle identity/graph = %+v", bundle)
	}
	var frozenRoot *deployment.BundleAgent
	for i := range bundle.Agents {
		if bundle.Agents[i].ID == root.ID {
			frozenRoot = &bundle.Agents[i]
		}
	}
	if frozenRoot == nil {
		t.Fatal("root missing from bundle")
	}
	if frozenRoot.ModelContextLimit != 128000 || frozenRoot.MaxSteps != agent.DefaultMaxSteps || frozenRoot.MaxTokens != agent.DefaultMaxTokens || frozenRoot.MaxRuns != agent.DefaultMaxTaskRuns || frozenRoot.ContextWindow != agent.DefaultContextWindow || frozenRoot.SummarizationModel != "gpt-4o" {
		t.Fatalf("resolved root values = %+v", frozenRoot)
	}
	if frozenRoot.MCPServers[0].BearerEnv != "CONTEXT7_TOKEN" {
		t.Fatalf("bearer env changed: %+v", frozenRoot.MCPServers)
	}
	reader := deployment.NewAgentReader(bundle, bundle.SyntheticUserID())
	if _, err := reader.GetByID(ctx, child.ID, bundle.SyntheticUserID()); err != nil {
		t.Fatalf("reader rejected delegate: %v", err)
	}
}
