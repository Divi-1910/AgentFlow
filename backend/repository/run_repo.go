package repository

import (
	"context"
	"fmt"
	"time"

	"backend/agent"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	retentionCompleted = 7 * 24 * time.Hour
	retentionFailed    = 30 * 24 * time.Hour
)

type RunRepo struct {
	runs        *mongo.Collection
	checkpoints *mongo.Collection
}

func NewRunRepo(runs, checkpoints *mongo.Collection) *RunRepo {
	return &RunRepo{runs: runs, checkpoints: checkpoints}
}

func (r *RunRepo) EnsureIndexes(ctx context.Context) error {
	_, err := r.runs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "run_id", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("run_repo: runs index: %w", err)
	}

	_, err = r.checkpoints.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "run_id", Value: 1},
			{Key: "step", Value: -1},
		},
	})
	if err != nil {
		return fmt.Errorf("run_repo: checkpoints index: %w", err)
	}

	_, err = r.checkpoints.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "expires_at", Value: 1}},
		Options: options.Index().SetSparse(true).SetExpireAfterSeconds(0),
	})
	if err != nil {
		return fmt.Errorf("run_repo: ttl index: %w", err)
	}

	return nil
}

func (r *RunRepo) CreateRun(ctx context.Context, runID, threadID, agentID, userID string) error {
	// Top-level run: it is its own originator, no parent.
	return r.createRun(ctx, runID, threadID, agentID, userID, runID, "", agent.InvocationTopLevel, "")
}

// CreateChildRun records a delegated (child) run with its delegation lineage.
func (r *RunRepo) CreateChildRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, agent.InvocationSyncDelegate, "")
}

func (r *RunRepo) CreateChildRunWithKind(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID)
}

func (r *RunRepo) createRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	now := time.Now()
	doc := model.RunDocument{
		ID:              bson.NewObjectID(),
		RunID:           runID,
		ThreadID:        threadID,
		AgentID:         agentID,
		UserID:          userID,
		Status:          model.RunStatusRunning,
		Attempt:         1,
		OriginatorRunID: originatorRunID,
		ParentRunID:     parentRunID,
		InvocationKind:  invocationKind,
		JobID:           jobID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if _, err := r.runs.InsertOne(ctx, doc); err != nil {
		return fmt.Errorf("run_repo: create run: %w", err)
	}
	return nil
}

func (r *RunRepo) Save(ctx context.Context, snapshot agent.RunSnapshot) error {
	gz, err := agent.CompressSnapshot(snapshot)
	if err != nil {
		return fmt.Errorf("run_repo: compress snapshot: %w", err)
	}

	doc := model.RunCheckpointDocument{
		ID:         bson.NewObjectID(),
		RunID:      snapshot.RunID,
		Step:       snapshot.State.StepsCompleted,
		Phase:      snapshot.Meta.Phase,
		SnapshotGZ: gz,
		CreatedAt:  time.Now(),
	}

	if _, err := r.checkpoints.InsertOne(ctx, doc); err != nil {
		return fmt.Errorf("run_repo: save checkpoint: %w", err)
	}

	_, _ = r.runs.UpdateOne(ctx,
		bson.M{"run_id": snapshot.RunID},
		bson.M{"$set": bson.M{
			"steps_completed": snapshot.State.StepsCompleted,
			"updated_at":      time.Now(),
		}},
	)

	return nil
}

func (r *RunRepo) LoadLatest(ctx context.Context, runID string) (*agent.RunSnapshot, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "step", Value: -1}, {Key: "created_at", Value: -1}})
	var doc model.RunCheckpointDocument
	err := r.checkpoints.FindOne(ctx, bson.M{"run_id": runID}, opts).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, fmt.Errorf("run_repo: no checkpoint found for run %s", runID)
	}
	if err != nil {
		return nil, fmt.Errorf("run_repo: load checkpoint: %w", err)
	}

	snapshot, err := agent.DecompressSnapshot(doc.SnapshotGZ)
	if err != nil {
		return nil, fmt.Errorf("run_repo: decompress checkpoint: %w", err)
	}
	return snapshot, nil
}

func (r *RunRepo) TransitionStatus(ctx context.Context, runID string, from, to string) (bool, error) {
	res, err := r.runs.UpdateOne(ctx,
		bson.M{"run_id": runID, "status": from},
		bson.M{"$set": bson.M{"status": to, "updated_at": time.Now()}},
	)
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status: %w", err)
	}
	return res.MatchedCount > 0, nil
}

func (r *RunRepo) TransitionStatusForUser(ctx context.Context, runID, userID string, from, to string) (bool, error) {
	res, err := r.runs.UpdateOne(ctx,
		bson.M{"run_id": runID, "user_id": userID, "status": from},
		bson.M{"$set": bson.M{"status": to, "updated_at": time.Now()}},
	)
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status for user: %w", err)
	}
	return res.MatchedCount > 0, nil
}

func (r *RunRepo) UpdateStatus(ctx context.Context, runID string, status string, lastError string) error {
	update := bson.M{"status": status, "updated_at": time.Now()}
	if lastError != "" {
		update["last_error"] = lastError
	}
	_, err := r.runs.UpdateOne(ctx,
		bson.M{"run_id": runID},
		bson.M{"$set": update},
	)
	if err != nil {
		return fmt.Errorf("run_repo: update status: %w", err)
	}

	var retention time.Duration
	switch model.RunStatus(status) {
	case model.RunStatusCompleted:
		retention = retentionCompleted
	case model.RunStatusFailed, model.RunStatusCancelled, model.RunStatusInterrupted:
		retention = retentionFailed
	}
	if retention > 0 {
		expiresAt := time.Now().Add(retention)
		_, _ = r.checkpoints.UpdateMany(ctx,
			bson.M{"run_id": runID},
			bson.M{"$set": bson.M{"expires_at": expiresAt}},
		)
	}
	return nil
}

func (r *RunRepo) IncrementAttempt(ctx context.Context, runID string) (int, error) {
	after := options.After
	opts := options.FindOneAndUpdate().SetReturnDocument(after)
	var doc model.RunDocument
	err := r.runs.FindOneAndUpdate(ctx,
		bson.M{"run_id": runID},
		bson.M{
			"$inc": bson.M{"attempt": 1},
			"$set": bson.M{"updated_at": time.Now()},
		},
		opts,
	).Decode(&doc)
	if err != nil {
		return 0, fmt.Errorf("run_repo: increment attempt: %w", err)
	}
	return doc.Attempt, nil
}

func (r *RunRepo) GetRun(ctx context.Context, runID string) (*agent.RunInfo, error) {
	var doc model.RunDocument
	err := r.runs.FindOne(ctx, bson.M{"run_id": runID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, fmt.Errorf("run_repo: run not found: %s", runID)
	}
	if err != nil {
		return nil, fmt.Errorf("run_repo: get run: %w", err)
	}
	return &agent.RunInfo{
		RunID:           doc.RunID,
		ThreadID:        doc.ThreadID,
		AgentID:         doc.AgentID,
		UserID:          doc.UserID,
		Status:          string(doc.Status),
		Attempt:         doc.Attempt,
		StepsCompleted:  doc.StepsCompleted,
		LastError:       doc.LastError,
		OriginatorRunID: doc.OriginatorRunID,
		ParentRunID:     doc.ParentRunID,
		InvocationKind:  doc.InvocationKind,
		JobID:           doc.JobID,
	}, nil
}

func (r *RunRepo) GetRunForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, error) {
	var doc model.RunDocument
	err := r.runs.FindOne(ctx, bson.M{"run_id": runID, "user_id": userID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, fmt.Errorf("run_repo: run not found: %s", runID)
	}
	if err != nil {
		return nil, fmt.Errorf("run_repo: get run for user: %w", err)
	}
	return &agent.RunInfo{
		RunID:           doc.RunID,
		ThreadID:        doc.ThreadID,
		AgentID:         doc.AgentID,
		UserID:          doc.UserID,
		Status:          string(doc.Status),
		Attempt:         doc.Attempt,
		StepsCompleted:  doc.StepsCompleted,
		LastError:       doc.LastError,
		OriginatorRunID: doc.OriginatorRunID,
		ParentRunID:     doc.ParentRunID,
		InvocationKind:  doc.InvocationKind,
		JobID:           doc.JobID,
	}, nil
}
