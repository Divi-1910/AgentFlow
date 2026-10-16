package mongorepo

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"backend/deployment/delivery"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var deliveryTokenHashRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

type DeploymentDeliveryTokenRepo struct{ col *mongo.Collection }

func NewDeploymentDeliveryTokenRepo(col *mongo.Collection) *DeploymentDeliveryTokenRepo {
	return &DeploymentDeliveryTokenRepo{col: col}
}

type deploymentDeliveryTokenBSON struct {
	ID                 bson.ObjectID `bson:"_id,omitempty"`
	TokenHash          string        `bson:"token_hash"`
	UserID             bson.ObjectID `bson:"user_id"`
	DeploymentID       string        `bson:"deployment_id"`
	Generation         int64         `bson:"generation"`
	Revision           int           `bson:"revision"`
	ConfigHash         string        `bson:"config_hash"`
	SchemaVersion      int           `bson:"schema_version"`
	CreatedAt          time.Time     `bson:"created_at"`
	ExpiresAt          time.Time     `bson:"expires_at"`
	RevokedAt          *time.Time    `bson:"revoked_at,omitempty"`
	LastAuthorizedAt   *time.Time    `bson:"last_authorized_at,omitempty"`
	AuthorizationCount int64         `bson:"authorization_count"`
}

func (r *DeploymentDeliveryTokenRepo) EnsureIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "token_hash", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("deployment_delivery_tokens_hash_unique"),
		},
		{
			Keys: bson.D{
				{Key: "user_id", Value: 1}, {Key: "deployment_id", Value: 1},
				{Key: "generation", Value: 1}, {Key: "expires_at", Value: 1},
			},
			Options: options.Index().SetName("deployment_delivery_tokens_scope"),
		},
		{
			Keys:    bson.D{{Key: "expires_at", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(0).SetName("deployment_delivery_tokens_expiry_ttl"),
		},
	}
	if _, err := r.col.Indexes().CreateMany(ctx, indexes); err != nil {
		return fmt.Errorf("deployment_delivery_token_repo: indexes: %w", err)
	}
	return nil
}

func (r *DeploymentDeliveryTokenRepo) Create(ctx context.Context, grant delivery.Grant) (*delivery.Grant, error) {
	uid, err := validateDeliveryGrant(grant)
	if err != nil {
		return nil, err
	}
	raw := deploymentDeliveryTokenBSON{
		ID: bson.NewObjectID(), TokenHash: grant.TokenHash, UserID: uid,
		DeploymentID: grant.DeploymentID, Generation: grant.Generation, Revision: grant.Revision,
		ConfigHash: grant.ConfigHash, SchemaVersion: grant.SchemaVersion,
		CreatedAt: grant.CreatedAt.UTC(), ExpiresAt: grant.ExpiresAt.UTC(),
		RevokedAt: grant.RevokedAt, LastAuthorizedAt: grant.LastAuthorizedAt,
		AuthorizationCount: grant.AuthorizationCount,
	}
	if _, err := r.col.InsertOne(ctx, raw); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil, delivery.ErrTokenHashConflict
		}
		return nil, fmt.Errorf("deployment_delivery_token_repo: create: %w", err)
	}
	return toDeliveryGrant(raw), nil
}

func (r *DeploymentDeliveryTokenRepo) FindByHash(ctx context.Context, tokenHash string) (*delivery.Grant, error) {
	if !deliveryTokenHashRE.MatchString(tokenHash) {
		return nil, delivery.ErrGrantNotFound
	}
	var raw deploymentDeliveryTokenBSON
	err := r.col.FindOne(ctx, bson.D{{Key: "token_hash", Value: tokenHash}}).Decode(&raw)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, delivery.ErrGrantNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_delivery_token_repo: find: %w", err)
	}
	return toDeliveryGrant(raw), nil
}

func (r *DeploymentDeliveryTokenRepo) RecordAuthorization(ctx context.Context, grantID string, authorizedAt time.Time) error {
	id, err := bson.ObjectIDFromHex(grantID)
	if err != nil || authorizedAt.IsZero() {
		return fmt.Errorf("deployment_delivery_token_repo: invalid authorization record")
	}
	result, err := r.col.UpdateOne(ctx,
		bson.D{
			{Key: "_id", Value: id},
			{Key: "revoked_at", Value: bson.D{{Key: "$exists", Value: false}}},
			{Key: "expires_at", Value: bson.D{{Key: "$gt", Value: authorizedAt.UTC()}}},
		},
		bson.D{
			{Key: "$set", Value: bson.D{{Key: "last_authorized_at", Value: authorizedAt.UTC()}}},
			{Key: "$inc", Value: bson.D{{Key: "authorization_count", Value: 1}}},
		},
	)
	if err != nil {
		return fmt.Errorf("deployment_delivery_token_repo: record authorization: %w", err)
	}
	if result.MatchedCount != 1 {
		return delivery.ErrGrantNotFound
	}
	return nil
}

func (r *DeploymentDeliveryTokenRepo) RevokeGeneration(ctx context.Context, userID, deploymentID string, generation int64, revokedAt time.Time) error {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil || deploymentID == "" || generation <= 0 || revokedAt.IsZero() {
		return fmt.Errorf("deployment_delivery_token_repo: invalid revocation scope")
	}
	_, err = r.col.UpdateMany(ctx,
		bson.D{
			{Key: "user_id", Value: uid}, {Key: "deployment_id", Value: deploymentID},
			{Key: "generation", Value: generation}, {Key: "revoked_at", Value: bson.D{{Key: "$exists", Value: false}}},
		},
		bson.D{{Key: "$set", Value: bson.D{{Key: "revoked_at", Value: revokedAt.UTC()}}}},
	)
	if err != nil {
		return fmt.Errorf("deployment_delivery_token_repo: revoke generation: %w", err)
	}
	return nil
}

func validateDeliveryGrant(grant delivery.Grant) (bson.ObjectID, error) {
	uid, err := bson.ObjectIDFromHex(grant.UserID)
	if err != nil {
		return bson.NilObjectID, fmt.Errorf("deployment_delivery_token_repo: invalid user_id: %w", err)
	}
	if !deliveryTokenHashRE.MatchString(grant.TokenHash) || grant.DeploymentID == "" || grant.Generation <= 0 ||
		grant.Revision <= 0 || !deploymentHashRE.MatchString(grant.ConfigHash) || grant.SchemaVersion <= 0 ||
		grant.CreatedAt.IsZero() || !grant.ExpiresAt.After(grant.CreatedAt) || grant.ID != "" ||
		grant.RevokedAt != nil || grant.LastAuthorizedAt != nil || grant.AuthorizationCount != 0 {
		return bson.NilObjectID, fmt.Errorf("deployment_delivery_token_repo: invalid grant")
	}
	return uid, nil
}

func toDeliveryGrant(raw deploymentDeliveryTokenBSON) *delivery.Grant {
	return &delivery.Grant{
		ID: raw.ID.Hex(), TokenHash: raw.TokenHash, UserID: raw.UserID.Hex(), DeploymentID: raw.DeploymentID,
		Generation: raw.Generation, Revision: raw.Revision, ConfigHash: raw.ConfigHash,
		SchemaVersion: raw.SchemaVersion, CreatedAt: raw.CreatedAt, ExpiresAt: raw.ExpiresAt,
		RevokedAt: raw.RevokedAt, LastAuthorizedAt: raw.LastAuthorizedAt,
		AuthorizationCount: raw.AuthorizationCount,
	}
}
