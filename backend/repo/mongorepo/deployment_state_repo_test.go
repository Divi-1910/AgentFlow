package mongorepo_test

import (
	"context"
	"errors"
	"testing"

	"backend/deployment"
	"backend/repo/mongorepo"
)

func TestDeploymentStatePointsToOwnedPublishedRevision(t *testing.T) {
	ctx := context.Background()
	revisionsCol := col(t, "deployment_revisions")
	revisions := mongorepo.NewDeploymentRevisionRepo(revisionsCol)
	if err := revisions.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	first, _, err := revisions.Append(ctx, revisionInput(revisionHash("state-1"), `{"revision":1}`))
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := revisions.Append(ctx, revisionInput(revisionHash("state-2"), `{"revision":2}`))
	if err != nil {
		t.Fatal(err)
	}
	states := mongorepo.NewDeploymentStateRepo(col(t, "deployment_states"), revisionsCol)
	if err := states.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}

	selected, err := states.PointToRevision(ctx, userA, first.DeploymentID, first.Revision)
	if err != nil || selected.Revision != 1 || selected.ConfigHash != first.ConfigHash {
		t.Fatalf("first selection = %+v err=%v", selected, err)
	}
	updated, err := states.PointToRevision(ctx, userA, second.DeploymentID, second.Revision)
	if err != nil || updated.Revision != 2 || updated.CreatedAt != selected.CreatedAt || updated.UpdatedAt.Before(selected.UpdatedAt) {
		t.Fatalf("updated selection = %+v err=%v", updated, err)
	}
	wantName, _ := deployment.ResourceName(second.DeploymentID, second.Revision, second.ConfigHash)
	if updated.ResourceName != wantName {
		t.Fatalf("resource name = %q, want %q", updated.ResourceName, wantName)
	}
	loaded, err := states.Get(ctx, userA, second.DeploymentID)
	if err != nil || loaded.Revision != 2 {
		t.Fatalf("Get = %+v err=%v", loaded, err)
	}
	if _, err := states.Get(ctx, userB, second.DeploymentID); !errors.Is(err, deployment.ErrDeployStateNotFound) {
		t.Fatalf("cross-owner Get = %v", err)
	}
	if _, err := states.PointToRevision(ctx, userB, second.DeploymentID, second.Revision); !errors.Is(err, deployment.ErrRevisionNotFound) {
		t.Fatalf("cross-owner PointToRevision = %v", err)
	}
	if _, err := states.PointToRevision(ctx, userA, second.DeploymentID, 99); !errors.Is(err, deployment.ErrRevisionNotFound) {
		t.Fatalf("missing PointToRevision = %v", err)
	}
}
