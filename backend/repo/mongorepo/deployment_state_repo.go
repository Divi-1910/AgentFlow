package mongorepo

import (
	"context"
	"fmt"
	"time"

	"backend/deployment"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type DeploymentStateRepo struct {
	states *mongo.Collection
}

func NewDeploymentStateRepo(states *mongo.Collection) *DeploymentStateRepo {
	return &DeploymentStateRepo{states: states}
}

type deploymentStateBSON struct {
	ID           bson.ObjectID `bson:"_id,omitempty"`
	UserID       bson.ObjectID `bson:"user_id"`
	DeploymentID string        `bson:"deployment_id"`
	Revision     int           `bson:"revision"`
	ConfigHash   string        `bson:"config_hash"`
	ResourceName string        `bson:"resource_name"`
	CreatedAt    time.Time     `bson:"created_at"`
	UpdatedAt    time.Time     `bson:"updated_at"`
}

func (r *DeploymentStateRepo) EnsureIndexes(ctx context.Context) error {
	_, err := r.states.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "user_id", Value: 1}, {Key: "deployment_id", Value: 1}},
		Options: options.Index().SetUnique(true).SetName("deployment_states_owner_deployment_unique"),
	})
	if err != nil {
		return fmt.Errorf("deployment_state_repo: indexes: %w", err)
	}
	return nil
}

func (r *DeploymentStateRepo) Select(ctx context.Context, input deployment.DeployStateInput) (*deployment.DeployState, error) {
	uid, err := bson.ObjectIDFromHex(input.UserID)
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: invalid user_id: %w", err)
	}
	wantName, err := deployment.ResourceName(input.DeploymentID, input.Revision, input.ConfigHash)
	if err != nil || input.ResourceName != wantName {
		return nil, deployment.ErrDeployStateConflict
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	filter := bson.D{{Key: "user_id", Value: uid}, {Key: "deployment_id", Value: input.DeploymentID}}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "revision", Value: input.Revision}, {Key: "config_hash", Value: input.ConfigHash},
			{Key: "resource_name", Value: input.ResourceName}, {Key: "updated_at", Value: now},
		}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "user_id", Value: uid}, {Key: "deployment_id", Value: input.DeploymentID}, {Key: "created_at", Value: now}}},
	}
	var raw deploymentStateBSON
	err = r.states.FindOneAndUpdate(ctx, filter, update, options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&raw)
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: point revision: %w", err)
	}
	return toDeployState(raw), nil
}

func (r *DeploymentStateRepo) Get(ctx context.Context, userID, deploymentID string) (*deployment.DeployState, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: invalid user_id: %w", err)
	}
	var raw deploymentStateBSON
	err = r.states.FindOne(ctx, bson.D{{Key: "user_id", Value: uid}, {Key: "deployment_id", Value: deploymentID}}).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, deployment.ErrDeployStateNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: get: %w", err)
	}
	return toDeployState(raw), nil
}

func toDeployState(raw deploymentStateBSON) *deployment.DeployState {
	return &deployment.DeployState{
		UserID: raw.UserID.Hex(), DeploymentID: raw.DeploymentID, Revision: raw.Revision,
		ConfigHash: raw.ConfigHash, ResourceName: raw.ResourceName,
		CreatedAt: raw.CreatedAt.UTC(), UpdatedAt: raw.UpdatedAt.UTC(),
	}
}
