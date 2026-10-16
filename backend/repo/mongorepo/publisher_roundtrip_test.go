package mongorepo_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"backend/agent"
	"backend/deployment"
	"backend/model"
	"backend/publisher"
	"backend/repo/mongorepo"
	"backend/tools"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestPublisherRoundTripThroughRuntimeBundleLoader(t *testing.T) {
	ctx := context.Background()
	agentsCol := col(t, "publisher_agents")
	modelsCol := col(t, "publisher_models")
	revisionsCol := col(t, "publisher_revisions")
	mcpServersCol := col(t, "publisher_mcp_servers")
	if _, err := modelsCol.InsertOne(ctx, model.LLMModel{
		ModelID: "catalog-gpt4o", Name: "GPT-4o", Provider: "openai", APIModelID: "gpt-4o", ContextWindow: 128000,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := mcpServersCol.InsertOne(ctx, model.MCPServerDocument{
		ID: bson.NewObjectID(), ServerID: "context7", Name: "Context7", Alias: "context7",
		StudioURL:     "http://localhost:8101/mcp",
		DeploymentURL: "http://context7.mcp-system.svc.cluster.local/mcp",
		Enabled:       true, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	agents := mongorepo.NewAgentRepo(agentsCol, modelsCol)
	mcpServers := mongorepo.NewMCPServerRepo(mcpServersCol)
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
		MCPServers: []agent.MCPServerSelection{{ServerID: "context7"}},
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
		Catalog: tools.NewCatalogRegistry(), MCPServers: mcpServers,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := svc.Publish(ctx, userA, root.ID, "roundtrip-publication-1")
	if err != nil {
		t.Fatal(err)
	}
	rootObjectID, err := bson.ObjectIDFromHex(root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := agentsCol.UpdateOne(ctx, bson.D{{Key: "_id", Value: rootObjectID}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "updated_at", Value: time.Now().UTC().Add(time.Hour)},
		{Key: "studio_layout", Value: bson.D{{Key: "x", Value: 120}, {Key: "y", Value: 80}}},
	}}}); err != nil {
		t.Fatal(err)
	}
	second, err := svc.Publish(ctx, userA, root.ID, "roundtrip-publication-2")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := svc.Publish(ctx, userA, root.ID, "roundtrip-publication-2")
	if err != nil {
		t.Fatal(err)
	}
	if first.WasExisting || second.WasExisting || !replay.WasExisting ||
		first.Revision.Revision != 1 || second.Revision.Revision != 2 || replay.Revision.Revision != 2 ||
		first.Revision.ConfigHash != second.Revision.ConfigHash {
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
	if len(frozenRoot.MCPServers) != 1 || frozenRoot.MCPServers[0].ServerID != "context7" ||
		frozenRoot.MCPServers[0].Alias != "context7" ||
		frozenRoot.MCPServers[0].URL != "http://context7.mcp-system.svc.cluster.local/mcp" {
		t.Fatalf("resolved MCP server changed: %+v", frozenRoot.MCPServers)
	}
	reader := deployment.NewAgentReader(bundle, bundle.SyntheticUserID())
	if _, err := reader.GetByID(ctx, child.ID, bundle.SyntheticUserID()); err != nil {
		t.Fatalf("reader rejected delegate: %v", err)
	}
}
