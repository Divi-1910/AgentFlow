package mongorepo

import (
	"context"
	"fmt"

	"backend/mcp"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MCPServerRepo struct {
	col *mongo.Collection
}

func NewMCPServerRepo(col *mongo.Collection) *MCPServerRepo {
	return &MCPServerRepo{col: col}
}

func (r *MCPServerRepo) EnsureIndexes(ctx context.Context) error {
	_, err := r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "server_id", Value: 1}},
		Options: options.Index().SetUnique(true).SetName("mcp_servers_server_id_unique"),
	})
	if err != nil {
		return fmt.Errorf("mcp_server_repo: create indexes: %w", err)
	}
	return nil
}

func (r *MCPServerRepo) ListEnabled(ctx context.Context) ([]mcp.CatalogEntry, error) {
	cursor, err := r.col.Find(
		ctx,
		bson.M{"enabled": true},
		options.Find().SetSort(bson.D{{Key: "name", Value: 1}, {Key: "server_id", Value: 1}}),
	)
	if err != nil {
		return nil, fmt.Errorf("mcp_server_repo: list enabled: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []model.MCPServerDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("mcp_server_repo: decode enabled: %w", err)
	}
	entries := make([]mcp.CatalogEntry, len(docs))
	for i, doc := range docs {
		entries[i] = mcpCatalogEntry(doc)
	}
	return entries, nil
}

func (r *MCPServerRepo) GetEnabledByIDs(ctx context.Context, serverIDs []string) (map[string]mcp.CatalogEntry, error) {
	entries := make(map[string]mcp.CatalogEntry)
	if len(serverIDs) == 0 {
		return entries, nil
	}

	unique := make([]string, 0, len(serverIDs))
	seen := make(map[string]struct{}, len(serverIDs))
	for _, serverID := range serverIDs {
		if _, exists := seen[serverID]; exists {
			continue
		}
		seen[serverID] = struct{}{}
		unique = append(unique, serverID)
	}

	cursor, err := r.col.Find(ctx, bson.M{
		"server_id": bson.M{"$in": unique},
		"enabled":   true,
	})
	if err != nil {
		return nil, fmt.Errorf("mcp_server_repo: get enabled: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []model.MCPServerDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("mcp_server_repo: decode selected: %w", err)
	}
	for _, doc := range docs {
		entry := mcpCatalogEntry(doc)
		entries[entry.ServerID] = entry
	}
	return entries, nil
}

func mcpCatalogEntry(doc model.MCPServerDocument) mcp.CatalogEntry {
	return mcp.CatalogEntry{
		ServerID: doc.ServerID, Name: doc.Name, Description: doc.Description,
		Alias: doc.Alias, StudioURL: doc.StudioURL, DeploymentURL: doc.DeploymentURL,
		Enabled: doc.Enabled, CreatedAt: doc.CreatedAt, UpdatedAt: doc.UpdatedAt,
	}
}
