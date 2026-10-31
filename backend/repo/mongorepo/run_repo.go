package mongorepo

import (
	"context"
	"fmt"
	"time"

	"backend/agent"
	"backend/model"
	"backend/pagination"

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

type RecoveryResult struct {
	Interrupted int64
	Failed      int64
	Cancelled   int64
}

func NewRunRepo(runs, checkpoints *mongo.Collection) *RunRepo {
	return &RunRepo{runs: runs, checkpoints: checkpoints}
}

func (r *RunRepo) RecoverOrphanedRuns(ctx context.Context, userID string) (RecoveryResult, error) {
	result := RecoveryResult{}
	filter := bson.M{"status": bson.M{"$in": bson.A{model.RunStatusRunning, model.RunStatusCancelling}}}
	if userID != "" {
		filter["user_id"] = userID
	}
	cursor, err := r.runs.Find(ctx, filter)
	if err != nil {
		return result, fmt.Errorf("run_repo: find orphaned runs: %w", err)
	}
	defer cursor.Close(ctx)
	var docs []model.RunDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return result, fmt.Errorf("run_repo: decode orphaned runs: %w", err)
	}
	for _, doc := range docs {
		if doc.Status == model.RunStatusCancelling {
			applied, err := r.TransitionStatus(ctx, doc.RunID, string(model.RunStatusCancelling), string(model.RunStatusCancelled))
			if err != nil {
				return result, err
			}
			if applied {
				result.Cancelled++
			}
			continue
		}
		// A keyed admission with no dispatch claim is not an orphaned execution:
		// no worker ever owned it. Keep it running so a same-key client retry can
		// durably claim dispatch. Legacy rows have no submission key and retain
		// the pre-admission recovery behavior.
		if doc.SubmissionKey != "" && !doc.DispatchStarted {
			continue
		}
		count, err := r.checkpoints.CountDocuments(ctx, bson.M{"run_id": doc.RunID})
		if err != nil {
			return result, fmt.Errorf("run_repo: inspect orphan checkpoint: %w", err)
		}
		to := model.RunStatusFailed
		lastError := "runtime restarted before first checkpoint"
		if count > 0 {
			to = model.RunStatusInterrupted
			lastError = ""
		}
		update := statusUpdate(string(to), lastError)
		res, err := r.runs.UpdateOne(ctx, bson.M{"run_id": doc.RunID, "status": model.RunStatusRunning}, update)
		if err != nil {
			return result, fmt.Errorf("run_repo: recover orphaned run: %w", err)
		}
		if res.MatchedCount == 0 {
			continue
		}
		if to == model.RunStatusInterrupted {
			result.Interrupted++
		} else {
			result.Failed++
		}
	}
	return result, nil
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

	_, err = r.runs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "user_id", Value: 1},
			{Key: "thread_id", Value: 1},
			{Key: "created_at", Value: -1},
		},
	})
	if err != nil {
		return fmt.Errorf("run_repo: thread history index: %w", err)
	}

	_, err = r.runs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "user_id", Value: 1}, {Key: "thread_id", Value: 1}, {Key: "submission_key", Value: 1}},
		Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{
			"submission_key": bson.M{"$type": "string"},
		}),
	})
	if err != nil {
		return fmt.Errorf("run_repo: submission index: %w", err)
	}

	_, err = r.runs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "active_slot", Value: 1}},
		Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{
			"active_slot": bson.M{"$type": "string"},
		}),
	})
	if err != nil {
		return fmt.Errorf("run_repo: active slot index: %w", err)
	}

	_, err = r.runs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "user_id", Value: 1}, {Key: "parent_run_id", Value: 1},
			{Key: "invocation_kind", Value: 1}, {Key: "created_at", Value: -1},
			{Key: "run_id", Value: -1},
		},
		Options: options.Index().SetName("run_owner_timeline"),
	})
	if err != nil {
		return fmt.Errorf("run_repo: owner timeline index: %w", err)
	}

	return nil
}

func activeSlot(userID, threadID string) string { return userID + ":" + threadID }

func (r *RunRepo) AdmitTopLevelRun(ctx context.Context, in agent.RunAdmission) (agent.RunAdmissionResult, error) {
	now := time.Now()
	doc := model.RunDocument{
		ID: bson.NewObjectID(), RunID: in.RunID, ThreadID: in.ThreadID, AgentID: in.AgentID,
		UserID: in.UserID, TeamID: in.TeamID, Status: model.RunStatusRunning, Attempt: 1,
		OriginatorRunID: in.RunID, InvocationKind: agent.InvocationTopLevel,
		SubmissionKey: in.SubmissionKey, AcceptedInput: in.AcceptedInput,
		ActiveSlot: activeSlot(in.UserID, in.ThreadID), CreatedAt: now, UpdatedAt: now,
	}
	if _, err := r.runs.InsertOne(ctx, doc); err == nil {
		return agent.RunAdmissionResult{Run: toRunInfo(doc), Created: true}, nil
	} else if !mongo.IsDuplicateKeyError(err) {
		return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: admit run: %w", err)
	}

	var existing model.RunDocument
	err := r.runs.FindOne(ctx, bson.M{
		"user_id": in.UserID, "thread_id": in.ThreadID, "submission_key": in.SubmissionKey,
	}).Decode(&existing)
	if err == nil {
		if existing.AcceptedInput != in.AcceptedInput || existing.AgentID != in.AgentID {
			return agent.RunAdmissionResult{Run: toRunInfo(existing)}, agent.ErrSubmissionKeyConflict
		}
		return agent.RunAdmissionResult{Run: toRunInfo(existing), Replayed: true}, nil
	}
	if err != mongo.ErrNoDocuments {
		return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: inspect duplicate submission: %w", err)
	}
	err = r.runs.FindOne(ctx, bson.M{"active_slot": activeSlot(in.UserID, in.ThreadID)}).Decode(&existing)
	if err == nil {
		return agent.RunAdmissionResult{Run: toRunInfo(existing), ActiveRun: existing.RunID}, agent.ErrThreadRunActive
	}
	if err != mongo.ErrNoDocuments {
		return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: inspect active run: %w", err)
	}
	return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: duplicate admission without conflicting record")
}

func (r *RunRepo) MarkPromptPersisted(ctx context.Context, runID string) error {
	_, err := r.runs.UpdateOne(ctx, bson.M{"run_id": runID}, bson.M{"$set": bson.M{"prompt_persisted": true, "updated_at": time.Now()}})
	if err != nil {
		return fmt.Errorf("run_repo: mark prompt persisted: %w", err)
	}
	return nil
}

func (r *RunRepo) ClaimRunDispatch(ctx context.Context, runID string) (bool, error) {
	res, err := r.runs.UpdateOne(ctx, bson.M{
		"run_id": runID, "status": model.RunStatusRunning,
		"dispatch_started": bson.M{"$ne": true},
	}, bson.M{"$set": bson.M{"dispatch_started": true, "updated_at": time.Now()}})
	if err != nil {
		return false, fmt.Errorf("run_repo: claim dispatch: %w", err)
	}
	return res.MatchedCount > 0, nil
}

func (r *RunRepo) ListPendingAcceptedPrompts(ctx context.Context, userID string) ([]*agent.RunInfo, error) {
	filter := bson.M{"accepted_input": bson.M{"$type": "string", "$ne": ""}, "prompt_persisted": bson.M{"$ne": true}}
	if userID != "" {
		filter["user_id"] = userID
	}
	cursor, err := r.runs.Find(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("run_repo: list pending prompts: %w", err)
	}
	defer cursor.Close(ctx)
	var docs []model.RunDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("run_repo: decode pending prompts: %w", err)
	}
	infos := make([]*agent.RunInfo, len(docs))
	for i, doc := range docs {
		infos[i] = toRunInfo(doc)
	}
	return infos, nil
}

func (r *RunRepo) CreateRun(ctx context.Context, runID, threadID, agentID, userID string) error {
	// Top-level run: it is its own originator, no parent.
	return r.createRun(ctx, runID, threadID, agentID, userID, runID, "", agent.InvocationTopLevel, "")
}

// CreateChildRun records a delegated (child) run with its delegation lineage.
func (r *RunRepo) CreateChildRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, agent.InvocationSyncDelegate, "")
}

func (r *RunRepo) CreateTeamChildRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, teamID string) error {
	return r.createTeamRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, agent.InvocationSyncDelegate, "", teamID)
}

func (r *RunRepo) CreateChildRunWithKind(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID)
}

func (r *RunRepo) CreateTeamChildRunWithKind(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID, teamID string) error {
	return r.createTeamRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID, teamID)
}

func (r *RunRepo) createRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	return r.createTeamRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID, "")
}

func (r *RunRepo) createTeamRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID, teamID string) error {
	now := time.Now()
	doc := model.RunDocument{
		ID:              bson.NewObjectID(),
		RunID:           runID,
		ThreadID:        threadID,
		AgentID:         agentID,
		TeamID:          teamID,
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

// Save appends a checkpoint for the run, keyed by step
// (snapshot.State.StepsCompleted). Because LoadLatest selects by highest step,
// re-saving an earlier step never shadows a later one.
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

// LoadLatest returns the snapshot with the highest step (ties broken by newest
// created_at), or an error when the run has no checkpoint.
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

// TransitionStatus is an atomic compare-and-set: it moves the run to `to` and
// returns true ONLY if the run's current status was `from`. A racing or repeated
// caller that observes a changed status gets false (not an error). This is the
// primitive that lets exactly one resume win the claim.
func (r *RunRepo) TransitionStatus(ctx context.Context, runID string, from, to string) (bool, error) {
	update := statusUpdate(to, "")
	res, err := r.runs.UpdateOne(ctx,
		bson.M{"run_id": runID, "status": from},
		update,
	)
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status: %w", err)
	}
	return res.MatchedCount > 0, nil
}

// TransitionStatusForUser is TransitionStatus additionally scoped to the owning
// user: the CAS matches only when the status is `from` AND user_id matches.
func (r *RunRepo) TransitionStatusForUser(ctx context.Context, runID, userID string, from, to string) (bool, error) {
	update := statusUpdate(to, "")
	res, err := r.runs.UpdateOne(ctx,
		bson.M{"run_id": runID, "user_id": userID, "status": from},
		update,
	)
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status for user: %w", err)
	}
	return res.MatchedCount > 0, nil
}

func (r *RunRepo) UpdateStatus(ctx context.Context, runID string, status string, lastError string) error {
	filter := bson.M{"run_id": runID}
	filter["$or"] = bson.A{
		bson.M{"status": bson.M{"$nin": bson.A{model.RunStatusCancelling, model.RunStatusCancelled, model.RunStatusCompleted, model.RunStatusFailed}}},
		bson.M{"status": status},
	}
	result, err := r.runs.UpdateOne(ctx,
		filter,
		statusUpdate(status, lastError),
	)
	if err != nil {
		return fmt.Errorf("run_repo: update status: %w", err)
	}
	if result.MatchedCount == 0 {
		return nil
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

func statusUpdate(status, lastError string) bson.M {
	set := bson.M{"status": status, "updated_at": time.Now()}
	if lastError != "" {
		set["last_error"] = lastError
	}
	update := bson.M{"$set": set}
	if isTerminalRunStatus(status) {
		update["$unset"] = bson.M{"active_slot": ""}
	}
	return update
}

func isTerminalRunStatus(status string) bool {
	switch model.RunStatus(status) {
	case model.RunStatusCompleted, model.RunStatusFailed, model.RunStatusCancelled:
		return true
	default:
		return false
	}
}

func (r *RunRepo) ResumeTopLevelRunForUser(ctx context.Context, runID, userID string, from []string) (int, bool, error) {
	info, err := r.GetRunForUser(ctx, runID, userID)
	if err != nil {
		return 0, false, err
	}
	filter := bson.M{
		"run_id": runID, "user_id": userID, "status": bson.M{"$in": from},
		"parent_run_id":   bson.M{"$in": bson.A{"", nil}},
		"invocation_kind": bson.M{"$in": bson.A{"", agent.InvocationTopLevel, nil}},
	}
	after := options.After
	var doc model.RunDocument
	err = r.runs.FindOneAndUpdate(ctx, filter, bson.M{
		"$set": bson.M{"status": model.RunStatusRunning, "active_slot": activeSlot(userID, info.ThreadID), "updated_at": time.Now()},
		"$inc": bson.M{"attempt": 1},
	}, options.FindOneAndUpdate().SetReturnDocument(after)).Decode(&doc)
	if err == nil {
		return doc.Attempt, true, nil
	}
	if mongo.IsDuplicateKeyError(err) {
		return 0, false, agent.ErrThreadRunActive
	}
	if err == mongo.ErrNoDocuments {
		return 0, false, nil
	}
	return 0, false, fmt.Errorf("run_repo: resume run: %w", err)
}

func (r *RunRepo) RequestCancelForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, bool, error) {
	before := options.Before
	var doc model.RunDocument
	err := r.runs.FindOneAndUpdate(ctx, bson.M{
		"run_id": runID, "user_id": userID,
		"status":          bson.M{"$in": bson.A{model.RunStatusRunning, model.RunStatusWaitingJobs, model.RunStatusResumable, model.RunStatusInterrupted}},
		"parent_run_id":   bson.M{"$in": bson.A{"", nil}},
		"invocation_kind": bson.M{"$in": bson.A{"", agent.InvocationTopLevel, nil}},
	}, bson.M{"$set": bson.M{"status": model.RunStatusCancelling, "updated_at": time.Now()}},
		options.FindOneAndUpdate().SetReturnDocument(before)).Decode(&doc)
	if err == nil {
		return toRunInfo(doc), true, nil
	}
	if err != mongo.ErrNoDocuments {
		return nil, false, fmt.Errorf("run_repo: request cancel: %w", err)
	}
	info, getErr := r.GetRunForUser(ctx, runID, userID)
	return info, false, getErr
}

func (r *RunRepo) FinalizeCancelForUser(ctx context.Context, runID, userID string) (bool, error) {
	res, err := r.runs.UpdateOne(ctx,
		bson.M{
			"run_id": runID, "user_id": userID, "status": model.RunStatusCancelling,
			"parent_run_id":   bson.M{"$in": bson.A{"", nil}},
			"invocation_kind": bson.M{"$in": bson.A{"", agent.InvocationTopLevel, nil}},
		},
		statusUpdate(string(model.RunStatusCancelled), "cancelled by user"),
	)
	if err != nil {
		return false, fmt.Errorf("run_repo: finalize cancel: %w", err)
	}
	if res.MatchedCount > 0 {
		if err := r.UpdateStatus(ctx, runID, string(model.RunStatusCancelled), "cancelled by user"); err != nil {
			return false, err
		}
	}
	return res.MatchedCount > 0, nil
}

// IncrementAttempt atomically increments the run's attempt counter and returns
// the post-increment value (monotonic; values are never reused).
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
	return toRunInfo(doc), nil
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
	return toRunInfo(doc), nil
}

func (r *RunRepo) ListTopLevelByThreadForUser(ctx context.Context, threadID, userID string, limit int) ([]*agent.RunInfo, error) {
	if limit <= 0 {
		limit = 50
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}, {Key: "run_id", Value: -1}}).
		SetLimit(int64(limit))
	cursor, err := r.runs.Find(ctx, bson.M{
		"thread_id":       threadID,
		"user_id":         userID,
		"parent_run_id":   bson.M{"$in": bson.A{"", nil}},
		"invocation_kind": bson.M{"$in": bson.A{"", agent.InvocationTopLevel, nil}},
	}, opts)
	if err != nil {
		return nil, fmt.Errorf("run_repo: list thread runs: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []model.RunDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("run_repo: decode thread runs: %w", err)
	}
	infos := make([]*agent.RunInfo, len(docs))
	for i, doc := range docs {
		infos[i] = toRunInfo(doc)
	}
	return infos, nil
}

func (r *RunRepo) ListTopLevelPageForUser(ctx context.Context, userID string, filter agent.RunListFilter, request pagination.Request) (pagination.Page[*agent.RunInfo], error) {
	if request.Limit <= 0 {
		request.Limit = 50
	}
	query := bson.M{
		"user_id":         userID,
		"parent_run_id":   bson.M{"$in": bson.A{"", nil}},
		"invocation_kind": bson.M{"$in": bson.A{"", agent.InvocationTopLevel, nil}},
	}
	if filter.ThreadID != "" {
		query["thread_id"] = filter.ThreadID
	}
	if filter.ResourceID != "" {
		query["agent_id"] = filter.ResourceID
	}
	if len(filter.Statuses) > 0 {
		query["status"] = bson.M{"$in": filter.Statuses}
	}
	if request.Cursor != nil {
		query["$or"] = bson.A{
			bson.M{"created_at": bson.M{"$lt": request.Cursor.Time}},
			bson.M{"created_at": request.Cursor.Time, "run_id": bson.M{"$lt": request.Cursor.ID}},
		}
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}, {Key: "run_id", Value: -1}}).
		SetLimit(int64(request.Limit + 1))
	cursor, err := r.runs.Find(ctx, query, opts)
	if err != nil {
		return pagination.Page[*agent.RunInfo]{}, fmt.Errorf("run_repo: list owner runs: %w", err)
	}
	defer cursor.Close(ctx)
	var docs []model.RunDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return pagination.Page[*agent.RunInfo]{}, fmt.Errorf("run_repo: decode owner runs: %w", err)
	}
	hasMore := len(docs) > request.Limit
	if hasMore {
		docs = docs[:request.Limit]
	}
	items := make([]*agent.RunInfo, len(docs))
	for i, doc := range docs {
		items[i] = toRunInfo(doc)
	}
	page := pagination.Page[*agent.RunInfo]{Items: items, HasMore: hasMore}
	if hasMore && len(docs) > 0 {
		last := docs[len(docs)-1]
		page.Next = &pagination.Cursor{Kind: "runs", Time: last.CreatedAt, ID: last.RunID}
	}
	return page, nil
}

func toRunInfo(doc model.RunDocument) *agent.RunInfo {
	return &agent.RunInfo{
		RunID:           doc.RunID,
		ThreadID:        doc.ThreadID,
		AgentID:         doc.AgentID,
		TeamID:          doc.TeamID,
		UserID:          doc.UserID,
		Status:          string(doc.Status),
		Attempt:         doc.Attempt,
		StepsCompleted:  doc.StepsCompleted,
		LastError:       doc.LastError,
		OriginatorRunID: doc.OriginatorRunID,
		ParentRunID:     doc.ParentRunID,
		InvocationKind:  doc.InvocationKind,
		JobID:           doc.JobID,
		SubmissionKey:   doc.SubmissionKey,
		AcceptedInput:   doc.AcceptedInput,
		PromptPersisted: doc.PromptPersisted,
		DispatchStarted: doc.DispatchStarted,
		CreatedAt:       doc.CreatedAt,
		UpdatedAt:       doc.UpdatedAt,
	}
}
