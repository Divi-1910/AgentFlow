package mongorepo_test

import (
	"context"
	"testing"
	"time"

	"backend/model"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestMCPServerRepoListsAndResolvesOnlyEnabledEntries(t *testing.T) {
	ctx := context.Background()
	collection := col(t, "mcp_servers")
	repo := mongorepo.NewMCPServerRepo(collection)
	if err := repo.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	docs := []any{
		model.MCPServerDocument{ID: bson.NewObjectID(), ServerID: "weather", Name: "Weather", Alias: "weather", StudioURL: "http://localhost:8103/mcp", DeploymentURL: "http://weather.mcp.svc/mcp", Enabled: true, CreatedAt: now, UpdatedAt: now},
		model.MCPServerDocument{ID: bson.NewObjectID(), ServerID: "fetch", Name: "Fetch", Alias: "fetch", StudioURL: "http://localhost:8102/mcp", DeploymentURL: "http://fetch.mcp.svc/mcp", Enabled: true, CreatedAt: now, UpdatedAt: now},
		model.MCPServerDocument{ID: bson.NewObjectID(), ServerID: "disabled", Name: "Disabled", Alias: "disabled", StudioURL: "http://localhost:8199/mcp", DeploymentURL: "http://disabled.mcp.svc/mcp", Enabled: false, CreatedAt: now, UpdatedAt: now},
	}
	if _, err := collection.InsertMany(ctx, docs); err != nil {
		t.Fatal(err)
	}

	listed, err := repo.ListEnabled(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 || listed[0].ServerID != "fetch" || listed[1].ServerID != "weather" {
		t.Fatalf("enabled list = %+v", listed)
	}
	resolved, err := repo.GetEnabledByIDs(ctx, []string{"weather", "disabled", "missing", "weather"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 1 || resolved["weather"].DeploymentURL != "http://weather.mcp.svc/mcp" {
		t.Fatalf("resolved entries = %+v", resolved)
	}
}

func TestMCPServerRepoEnforcesUniqueServerID(t *testing.T) {
	ctx := context.Background()
	collection := col(t, "mcp_server_unique")
	repo := mongorepo.NewMCPServerRepo(collection)
	if err := repo.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	doc := model.MCPServerDocument{ID: bson.NewObjectID(), ServerID: "fetch", Name: "Fetch", Alias: "fetch", Enabled: true}
	if _, err := collection.InsertOne(ctx, doc); err != nil {
		t.Fatal(err)
	}
	doc.ID = bson.NewObjectID()
	if _, err := collection.InsertOne(ctx, doc); err == nil {
		t.Fatal("duplicate server_id was accepted")
	}
}
