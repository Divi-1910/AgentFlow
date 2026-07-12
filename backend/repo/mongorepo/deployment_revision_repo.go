package mongorepo

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"backend/deployment"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const maxRevisionInsertAttempts = 10

var deploymentHashRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

type DeploymentRevisionRepo struct{ col *mongo.Collection }

func NewDeploymentRevisionRepo(col *mongo.Collection) *DeploymentRevisionRepo {
	return &DeploymentRevisionRepo{col: col}
}

type deploymentRevisionBSON struct {
	ID            bson.ObjectID `bson:"_id,omitempty"`
	UserID        bson.ObjectID `bson:"user_id"`
	DeploymentID  string        `bson:"deployment_id"`
	RootAgentID   string        `bson:"root_agent_id"`
	Revision      int           `bson:"revision"`
	ConfigHash    string        `bson:"config_hash"`
	SchemaVersion int           `bson:"schema_version"`
	BundleJSON    []byte        `bson:"bundle_json"`
	CreatedAt     time.Time     `bson:"created_at"`
}

func (r *DeploymentRevisionRepo) EnsureIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "deployment_id", Value: 1}, {Key: "revision", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("deployment_revisions_revision_unique"),
		},
		{
			Keys:    bson.D{{Key: "deployment_id", Value: 1}, {Key: "config_hash", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("deployment_revisions_hash_unique"),
		},
	}
	if _, err := r.col.Indexes().CreateMany(ctx, indexes); err != nil {
		return fmt.Errorf("deployment_revision_repo: indexes: %w", err)
	}
	return nil
}

func (r *DeploymentRevisionRepo) Append(ctx context.Context, input deployment.RevisionInput) (*deployment.Revision, bool, error) {
	uid, err := validateRevisionInput(input)
	if err != nil {
		return nil, false, err
	}
	if existing, err := r.findByHash(ctx, uid, input.DeploymentID, input.ConfigHash); err != nil {
		return nil, false, err
	} else if existing != nil {
		return existing, true, nil
	}

	for attempt := 0; attempt < maxRevisionInsertAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		latest, err := r.latestRevision(ctx, uid, input.DeploymentID)
		if err != nil {
			return nil, false, err
		}
		raw := deploymentRevisionBSON{
			ID: bson.NewObjectID(), UserID: uid, DeploymentID: input.DeploymentID, RootAgentID: input.RootAgentID,
			Revision: latest + 1, ConfigHash: input.ConfigHash, SchemaVersion: input.SchemaVersion,
			BundleJSON: append([]byte(nil), input.BundleJSON...), CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
		}
		if _, err := r.col.InsertOne(ctx, raw); err == nil {
			revision := toDeploymentRevision(raw)
			return revision, false, nil
		} else if !mongo.IsDuplicateKeyError(err) {
			return nil, false, fmt.Errorf("deployment_revision_repo: append: %w", err)
		}
		if existing, err := r.findByHash(ctx, uid, input.DeploymentID, input.ConfigHash); err != nil {
			return nil, false, err
		} else if existing != nil {
			return existing, true, nil
		}
	}
	return nil, false, fmt.Errorf("deployment_revision_repo: allocate revision after %d attempts", maxRevisionInsertAttempts)
}

func (r *DeploymentRevisionRepo) Get(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("deployment_revision_repo: invalid user_id: %w", err)
	}
	if deploymentID == "" || revision <= 0 {
		return nil, deployment.ErrRevisionNotFound
	}
	var raw deploymentRevisionBSON
	err = r.col.FindOne(ctx, bson.D{
		{Key: "user_id", Value: uid},
		{Key: "deployment_id", Value: deploymentID},
		{Key: "revision", Value: revision},
	}).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, deployment.ErrRevisionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_revision_repo: get: %w", err)
	}
	return toDeploymentRevision(raw), nil
}

func validateRevisionInput(input deployment.RevisionInput) (bson.ObjectID, error) {
	uid, err := bson.ObjectIDFromHex(input.UserID)
	if err != nil {
		return bson.NilObjectID, fmt.Errorf("deployment_revision_repo: invalid user_id: %w", err)
	}
	if input.DeploymentID == "" || input.RootAgentID == "" {
		return bson.NilObjectID, fmt.Errorf("deployment_revision_repo: deployment and root agent ids are required")
	}
	if !deploymentHashRE.MatchString(input.ConfigHash) {
		return bson.NilObjectID, fmt.Errorf("deployment_revision_repo: invalid config hash")
	}
	if input.SchemaVersion <= 0 {
		return bson.NilObjectID, fmt.Errorf("deployment_revision_repo: schema version must be positive")
	}
	if len(input.BundleJSON) == 0 {
		return bson.NilObjectID, fmt.Errorf("deployment_revision_repo: bundle JSON is required")
	}
	if len(input.BundleJSON) > deployment.MaxBundleBytes {
		return bson.NilObjectID, fmt.Errorf("deployment_revision_repo: bundle exceeds %d bytes", deployment.MaxBundleBytes)
	}
	return uid, nil
}

func (r *DeploymentRevisionRepo) findByHash(ctx context.Context, uid bson.ObjectID, deploymentID, hash string) (*deployment.Revision, error) {
	var raw deploymentRevisionBSON
	err := r.col.FindOne(ctx, bson.D{
		{Key: "user_id", Value: uid},
		{Key: "deployment_id", Value: deploymentID},
		{Key: "config_hash", Value: hash},
	}).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_revision_repo: find hash: %w", err)
	}
	return toDeploymentRevision(raw), nil
}

func (r *DeploymentRevisionRepo) latestRevision(ctx context.Context, uid bson.ObjectID, deploymentID string) (int, error) {
	var raw struct {
		Revision int `bson:"revision"`
	}
	err := r.col.FindOne(
		ctx,
		bson.D{{Key: "user_id", Value: uid}, {Key: "deployment_id", Value: deploymentID}},
		options.FindOne().SetSort(bson.D{{Key: "revision", Value: -1}}).SetProjection(bson.D{{Key: "revision", Value: 1}}),
	).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("deployment_revision_repo: latest: %w", err)
	}
	return raw.Revision, nil
}

func toDeploymentRevision(raw deploymentRevisionBSON) *deployment.Revision {
	return &deployment.Revision{
		UserID: raw.UserID.Hex(), DeploymentID: raw.DeploymentID, RootAgentID: raw.RootAgentID,
		Revision: raw.Revision, ConfigHash: raw.ConfigHash, SchemaVersion: raw.SchemaVersion,
		BundleJSON: append([]byte(nil), raw.BundleJSON...), CreatedAt: raw.CreatedAt.UTC(),
	}
}
