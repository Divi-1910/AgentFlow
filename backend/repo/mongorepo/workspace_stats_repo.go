package mongorepo

import (
	"context"
	"fmt"

	"backend/agent"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// WorkspaceStatsRepo owns aggregate queries used by the Studio overview. It
// intentionally returns counts rather than persistence documents so the HTTP
// layer does not need to load an unbounded run or deployment history.
type WorkspaceStatsRepo struct {
	runs   *mongo.Collection
	states *mongo.Collection
}

func NewWorkspaceStatsRepo(runs, states *mongo.Collection) *WorkspaceStatsRepo {
	return &WorkspaceStatsRepo{runs: runs, states: states}
}

func (r *WorkspaceStatsRepo) CountTopLevelRuns(ctx context.Context, userID string, statuses []string) (int64, error) {
	filter := bson.M{
		"user_id":         userID,
		"parent_run_id":   bson.M{"$in": bson.A{"", nil}},
		"invocation_kind": bson.M{"$in": bson.A{"", agent.InvocationTopLevel, nil}},
	}
	if len(statuses) > 0 {
		filter["status"] = bson.M{"$in": statuses}
	}
	count, err := r.runs.CountDocuments(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("workspace_stats_repo: count runs: %w", err)
	}
	return count, nil
}

func (r *WorkspaceStatsRepo) CountDeployments(ctx context.Context, userID string, phases []string) (int64, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return 0, fmt.Errorf("workspace_stats_repo: invalid owner: %w", err)
	}
	filter := bson.M{"user_id": uid}
	if len(phases) > 0 {
		filter["observed.phase"] = bson.M{"$in": phases}
	}
	count, err := r.states.CountDocuments(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("workspace_stats_repo: count deployments: %w", err)
	}
	return count, nil
}
