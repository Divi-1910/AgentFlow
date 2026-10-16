package mongorepo_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"backend/deployment/delivery"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func deliveryTokenRepo(t *testing.T) *mongorepo.DeploymentDeliveryTokenRepo {
	t.Helper()
	repo := mongorepo.NewDeploymentDeliveryTokenRepo(col(t, "deployment_delivery_tokens"))
	if err := repo.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	return repo
}

func TestDeploymentDeliveryTokenRepoLifecycle(t *testing.T) {
	ctx := context.Background()
	repo := deliveryTokenRepo(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	grant := deliveryGrant(now)

	created, err := repo.Create(ctx, grant)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.TokenHash != grant.TokenHash || created.UserID != grant.UserID {
		t.Fatalf("created = %+v", created)
	}

	found, err := repo.FindByHash(ctx, grant.TokenHash)
	if err != nil {
		t.Fatal(err)
	}
	if found.ID != created.ID || found.AuthorizationCount != 0 || found.LastAuthorizedAt != nil {
		t.Fatalf("found = %+v", found)
	}

	authorizedAt := now.Add(time.Minute)
	if err := repo.RecordAuthorization(ctx, created.ID, authorizedAt); err != nil {
		t.Fatal(err)
	}
	found, err = repo.FindByHash(ctx, grant.TokenHash)
	if err != nil {
		t.Fatal(err)
	}
	if found.AuthorizationCount != 1 || found.LastAuthorizedAt == nil || !found.LastAuthorizedAt.Equal(authorizedAt) {
		t.Fatalf("authorization fields = %+v", found)
	}

	if err := repo.RevokeGeneration(ctx, grant.UserID, grant.DeploymentID, grant.Generation, authorizedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	found, err = repo.FindByHash(ctx, grant.TokenHash)
	if err != nil {
		t.Fatal(err)
	}
	if found.RevokedAt == nil || !found.RevokedAt.Equal(authorizedAt.Add(time.Minute)) {
		t.Fatalf("revoked grant = %+v", found)
	}
}

func TestDeploymentDeliveryTokenRepoEnforcesUniqueHash(t *testing.T) {
	ctx := context.Background()
	repo := deliveryTokenRepo(t)
	grant := deliveryGrant(time.Now().UTC().Truncate(time.Millisecond))
	if _, err := repo.Create(ctx, grant); err != nil {
		t.Fatal(err)
	}
	grant.DeploymentID = "another-deployment"
	if _, err := repo.Create(ctx, grant); !errors.Is(err, delivery.ErrTokenHashConflict) {
		t.Fatalf("duplicate error = %v", err)
	}
}

func TestDeploymentDeliveryTokenRepoDoesNotPersistRawToken(t *testing.T) {
	ctx := context.Background()
	collection := col(t, "deployment_delivery_tokens_raw")
	repo := mongorepo.NewDeploymentDeliveryTokenRepo(collection)
	if err := repo.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	grant := deliveryGrant(time.Now().UTC().Truncate(time.Millisecond))
	if _, err := repo.Create(ctx, grant); err != nil {
		t.Fatal(err)
	}
	var raw bson.M
	if err := collection.FindOne(ctx, bson.D{{Key: "token_hash", Value: grant.TokenHash}}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if _, exists := raw["token"]; exists {
		t.Fatal("raw token field was persisted")
	}
}

func TestDeploymentDeliveryTokenRepoMissingGrant(t *testing.T) {
	repo := deliveryTokenRepo(t)
	if _, err := repo.FindByHash(context.Background(), strings.Repeat("f", 64)); !errors.Is(err, delivery.ErrGrantNotFound) {
		t.Fatalf("find error = %v", err)
	}
	if err := repo.RecordAuthorization(context.Background(), "507f1f77bcf86cd799439099", time.Now()); !errors.Is(err, delivery.ErrGrantNotFound) {
		t.Fatalf("record error = %v", err)
	}
}

func TestDeploymentDeliveryTokenRepoRecordsOnlyActiveGrant(t *testing.T) {
	ctx := context.Background()
	repo := deliveryTokenRepo(t)
	now := time.Now().UTC().Truncate(time.Millisecond)

	revokedGrant := deliveryGrant(now)
	revoked, err := repo.Create(ctx, revokedGrant)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.RevokeGeneration(ctx, revokedGrant.UserID, revokedGrant.DeploymentID, revokedGrant.Generation, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := repo.RecordAuthorization(ctx, revoked.ID, now.Add(2*time.Minute)); !errors.Is(err, delivery.ErrGrantNotFound) {
		t.Fatalf("revoked record error = %v", err)
	}

	expiringGrant := deliveryGrant(now)
	expiringGrant.TokenHash = strings.Repeat("c", 64)
	expiringGrant.Generation++
	expiringGrant.ExpiresAt = now.Add(5 * time.Minute)
	expiring, err := repo.Create(ctx, expiringGrant)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.RecordAuthorization(ctx, expiring.ID, expiringGrant.ExpiresAt); !errors.Is(err, delivery.ErrGrantNotFound) {
		t.Fatalf("expired record error = %v", err)
	}
}

func deliveryGrant(now time.Time) delivery.Grant {
	return delivery.Grant{
		TokenHash: strings.Repeat("a", 64), UserID: userA,
		DeploymentID: "507f1f77bcf86cd799439012", Generation: 4, Revision: 7,
		ConfigHash: strings.Repeat("b", 64), SchemaVersion: 1,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}
}
