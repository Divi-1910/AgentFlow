package mongorepo

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ResourceDependencyRepo performs the cross-collection checks that must pass
// before deleting an Agent or Agent Team. Deletion remains non-cascading: a
// resource with durable history must be retained until that history has an
// explicit product lifecycle of its own.
type ResourceDependencyRepo struct {
	agents    *mongo.Collection
	threads   *mongo.Collection
	revisions *mongo.Collection
	states    *mongo.Collection
}

func NewResourceDependencyRepo(agents, threads, revisions, states *mongo.Collection) *ResourceDependencyRepo {
	return &ResourceDependencyRepo{agents: agents, threads: threads, revisions: revisions, states: states}
}

func (r *ResourceDependencyRepo) BlockingDependencies(ctx context.Context, userID, resourceID string) ([]string, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("resource_dependency_repo: invalid owner: %w", err)
	}
	rid, err := bson.ObjectIDFromHex(resourceID)
	if err != nil {
		return nil, fmt.Errorf("resource_dependency_repo: invalid resource: %w", err)
	}
	checks := []struct {
		name       string
		collection *mongo.Collection
		filter     bson.M
	}{
		{name: "agent_team_membership", collection: r.agents, filter: bson.M{"user_id": uid, "team_graph.nodes.agent_id": resourceID}},
		{name: "threads", collection: r.threads, filter: bson.M{"user_id": uid, "agent_id": rid}},
		{name: "publications", collection: r.revisions, filter: bson.M{"user_id": uid, "deployment_id": resourceID}},
		{name: "deployment_state", collection: r.states, filter: bson.M{"user_id": uid, "deployment_id": resourceID}},
	}
	dependencies := []string{}
	for _, check := range checks {
		count, err := check.collection.CountDocuments(ctx, check.filter)
		if err != nil {
			return nil, fmt.Errorf("resource_dependency_repo: count %s: %w", check.name, err)
		}
		if count > 0 {
			dependencies = append(dependencies, check.name)
		}
	}
	return dependencies, nil
}
