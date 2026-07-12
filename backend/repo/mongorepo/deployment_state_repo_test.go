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
	states := mongorepo.NewDeploymentStateRepo(col(t, "deployment_states"))
	if err := states.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	service, err := deployment.NewService(states, revisions)
	if err != nil {
		t.Fatal(err)
	}

	selected, err := service.SelectRevision(ctx, userA, first.DeploymentID, first.Revision)
	if err != nil || selected.State.Revision != 1 || selected.State.ConfigHash != first.ConfigHash {
		t.Fatalf("first selection = %+v err=%v", selected, err)
	}
	updated, err := service.SelectRevision(ctx, userA, second.DeploymentID, second.Revision)
	if err != nil || updated.State.Revision != 2 || updated.State.CreatedAt != selected.State.CreatedAt || updated.State.UpdatedAt.Before(selected.State.UpdatedAt) {
		t.Fatalf("updated selection = %+v err=%v", updated, err)
	}
	wantName, _ := deployment.ResourceName(second.DeploymentID, second.Revision, second.ConfigHash)
	if updated.State.ResourceName != wantName {
		t.Fatalf("resource name = %q, want %q", updated.State.ResourceName, wantName)
	}
	loaded, err := service.GetSelectedRevision(ctx, userA, second.DeploymentID)
	if err != nil || loaded.State.Revision != 2 || loaded.Revision.ConfigHash != second.ConfigHash {
		t.Fatalf("Get = %+v err=%v", loaded, err)
	}
	if _, err := states.Get(ctx, userB, second.DeploymentID); !errors.Is(err, deployment.ErrDeployStateNotFound) {
		t.Fatalf("cross-owner Get = %v", err)
	}
	if _, err := service.SelectRevision(ctx, userB, second.DeploymentID, second.Revision); !errors.Is(err, deployment.ErrRevisionNotFound) {
		t.Fatalf("cross-owner SelectRevision = %v", err)
	}
	if _, err := service.SelectRevision(ctx, userA, second.DeploymentID, 99); !errors.Is(err, deployment.ErrRevisionNotFound) {
		t.Fatalf("missing SelectRevision = %v", err)
	}
}
