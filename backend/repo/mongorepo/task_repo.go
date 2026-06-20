package mongorepo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"backend/agent"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type TaskRepo struct {
	col *mongo.Collection
}

func NewTaskRepo(col *mongo.Collection) *TaskRepo {
	return &TaskRepo{col: col}
}

func (r *TaskRepo) EnsureIndexes(ctx context.Context) error {
	_, err := r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "originator_run_id", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("task_repo: originator index: %w", err)
	}
	_, err = r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "cancelled_at", Value: 1}},
	})
	if err != nil {
		return fmt.Errorf("task_repo: cancelled index: %w", err)
	}
	return nil
}

// EnsureTask idempotently creates the run-budget ledger for an originator run.
// The FIRST creation owns max_runs: a later EnsureTask with a different max_runs
// does NOT overwrite it (setOnInsert). Only missing or non-positive budget
// fields are repaired afterward (backfill), so an existing ledger's cap and
// usage are never reset.
func (r *TaskRepo) EnsureTask(ctx context.Context, originatorRunID, userID string, maxRuns int) error {
	if originatorRunID == "" {
		return nil
	}
	maxRuns = normalizeMaxRuns(maxRuns)
	now := time.Now()
	_, err := r.col.UpdateOne(ctx,
		bson.M{"originator_run_id": originatorRunID},
		bson.M{
			"$setOnInsert": bson.M{
				"_id":               bson.NewObjectID(),
				"originator_run_id": originatorRunID,
				"user_id":           userID,
				"max_runs":          maxRuns,
				"runs_used":         0,
				"run_budget_keys":   []string{},
				"created_at":        now,
			},
			"$set": bson.M{"updated_at": now},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("task_repo: ensure task: %w", err)
	}
	if err := r.backfillBudgetFields(ctx, originatorRunID, maxRuns); err != nil {
		return err
	}
	return nil
}

func (r *TaskRepo) CancelTask(ctx context.Context, originatorRunID, reason string) error {
	if originatorRunID == "" {
		return nil
	}
	now := time.Now()
	_, err := r.col.UpdateOne(ctx,
		bson.M{"originator_run_id": originatorRunID},
		bson.M{
			"$setOnInsert": bson.M{
				"_id":               bson.NewObjectID(),
				"originator_run_id": originatorRunID,
				"max_runs":          agent.DefaultMaxTaskRuns,
				"runs_used":         0,
				"run_budget_keys":   []string{},
				"created_at":        now,
			},
			"$set": bson.M{
				"cancelled_at":  now,
				"cancel_reason": reason,
				"updated_at":    now,
			},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("task_repo: cancel task: %w", err)
	}
	return nil
}

func (r *TaskRepo) IsCancelled(ctx context.Context, originatorRunID string) (bool, error) {
	if originatorRunID == "" {
		return false, nil
	}
	var doc model.TaskDocument
	err := r.col.FindOne(ctx, bson.M{"originator_run_id": originatorRunID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("task_repo: is cancelled: %w", err)
	}
	return doc.CancelledAt != nil, nil
}

func (r *TaskRepo) BudgetStatus(ctx context.Context, originatorRunID string) (agent.RunBudgetStatus, error) {
	if originatorRunID == "" {
		return budgetStatus(originatorRunID, agent.DefaultMaxTaskRuns, 0), nil
	}
	var doc model.TaskDocument
	err := r.col.FindOne(ctx, bson.M{"originator_run_id": originatorRunID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return budgetStatus(originatorRunID, agent.DefaultMaxTaskRuns, 0), nil
	}
	if err != nil {
		return agent.RunBudgetStatus{}, fmt.Errorf("task_repo: budget status: %w", err)
	}
	return taskBudgetStatus(doc), nil
}

// TryConsumeRun atomically consumes one run from the budget and reports whether
// it was granted. It is idempotent by budgetKey: replaying the same key returns
// true WITHOUT charging a second run (keys are recorded in run_budget_keys).
// When runs_used has reached max_runs the call returns (status, false) with
// status.Exhausted set — never an error.
func (r *TaskRepo) TryConsumeRun(ctx context.Context, originatorRunID, userID, budgetKey string) (agent.RunBudgetStatus, bool, error) {
	if originatorRunID == "" {
		return budgetStatus(originatorRunID, agent.DefaultMaxTaskRuns, 0), true, nil
	}
	if budgetKey == "" {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: budget key is required")
	}

	status, ok, err := r.tryConsumeRunAtomic(ctx, originatorRunID, budgetKey)
	if err != nil {
		return agent.RunBudgetStatus{}, false, err
	}
	if ok {
		return status, true, nil
	}

	doc, readErr := r.getTask(ctx, originatorRunID)
	if errors.Is(readErr, mongo.ErrNoDocuments) {
		if err := r.EnsureTask(ctx, originatorRunID, userID, agent.DefaultMaxTaskRuns); err != nil {
			return agent.RunBudgetStatus{}, false, err
		}
		status, ok, err = r.tryConsumeRunAtomic(ctx, originatorRunID, budgetKey)
		if err != nil {
			return agent.RunBudgetStatus{}, false, err
		}
		if ok {
			return status, true, nil
		}
		doc, readErr = r.getTask(ctx, originatorRunID)
	}
	if readErr != nil {
		return agent.RunBudgetStatus{}, false, readErr
	}

	if needsBudgetBackfill(doc) {
		if err := r.backfillBudgetFields(ctx, originatorRunID, agent.DefaultMaxTaskRuns); err != nil {
			return agent.RunBudgetStatus{}, false, err
		}
		status, ok, err = r.tryConsumeRunAtomic(ctx, originatorRunID, budgetKey)
		if err != nil {
			return agent.RunBudgetStatus{}, false, err
		}
		if ok {
			return status, true, nil
		}
		doc, readErr = r.getTask(ctx, originatorRunID)
		if readErr != nil {
			return agent.RunBudgetStatus{}, false, readErr
		}
	}

	status = taskBudgetStatus(doc)
	if containsString(doc.RunKeys, budgetKey) {
		return status, true, nil
	}
	return status, false, nil
}

func (r *TaskRepo) tryConsumeRunAtomic(ctx context.Context, originatorRunID, budgetKey string) (agent.RunBudgetStatus, bool, error) {
	now := time.Now()
	filter := bson.M{
		"originator_run_id": originatorRunID,
		"run_budget_keys":   bson.M{"$ne": budgetKey},
		"$expr":             bson.M{"$lt": bson.A{"$runs_used", "$max_runs"}},
	}
	update := bson.M{
		"$inc":      bson.M{"runs_used": 1},
		"$addToSet": bson.M{"run_budget_keys": budgetKey},
		"$set":      bson.M{"updated_at": now},
	}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var doc model.TaskDocument
	err := r.col.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc)
	if err == nil {
		return taskBudgetStatus(doc), true, nil
	}
	if err != mongo.ErrNoDocuments {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: consume run budget: %w", err)
	}
	return agent.RunBudgetStatus{}, false, nil
}

func (r *TaskRepo) backfillBudgetFields(ctx context.Context, originatorRunID string, maxRuns int) error {
	now := time.Now()
	updates := []struct {
		field         string
		missingFilter bson.M
		value         any
	}{
		{
			field: "max_runs",
			missingFilter: bson.M{
				"$or": []bson.M{
					{"max_runs": bson.M{"$exists": false}},
					{"max_runs": bson.M{"$lte": 0}},
				},
			},
			value: maxRuns,
		},
		{field: "runs_used", missingFilter: bson.M{"runs_used": bson.M{"$exists": false}}, value: 0},
		{field: "run_budget_keys", missingFilter: bson.M{"run_budget_keys": bson.M{"$exists": false}}, value: []string{}},
	}
	for _, u := range updates {
		filter := bson.M{"originator_run_id": originatorRunID}
		for key, value := range u.missingFilter {
			filter[key] = value
		}
		_, err := r.col.UpdateOne(ctx,
			filter,
			bson.M{"$set": bson.M{u.field: u.value, "updated_at": now}},
		)
		if err != nil {
			return fmt.Errorf("task_repo: backfill %s: %w", u.field, err)
		}
	}
	return nil
}

func (r *TaskRepo) getTask(ctx context.Context, originatorRunID string) (model.TaskDocument, error) {
	var doc model.TaskDocument
	err := r.col.FindOne(ctx, bson.M{"originator_run_id": originatorRunID}).Decode(&doc)
	if err != nil {
		return model.TaskDocument{}, fmt.Errorf("task_repo: get task: %w", err)
	}
	return doc, nil
}

func taskBudgetStatus(doc model.TaskDocument) agent.RunBudgetStatus {
	return budgetStatus(doc.OriginatorRunID, doc.MaxRuns, doc.RunsUsed)
}

func needsBudgetBackfill(doc model.TaskDocument) bool {
	return doc.MaxRuns <= 0 || doc.RunKeys == nil
}

func budgetStatus(originatorRunID string, maxRuns, runsUsed int) agent.RunBudgetStatus {
	maxRuns = normalizeMaxRuns(maxRuns)
	return agent.RunBudgetStatus{
		OriginatorRunID: originatorRunID,
		MaxRuns:         maxRuns,
		RunsUsed:        runsUsed,
		Exhausted:       runsUsed >= maxRuns,
	}
}

func normalizeMaxRuns(maxRuns int) int {
	if maxRuns <= 0 {
		return agent.DefaultMaxTaskRuns
	}
	return maxRuns
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
