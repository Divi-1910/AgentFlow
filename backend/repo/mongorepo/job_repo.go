package mongorepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"time"

	"backend/agent"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type JobRepo struct {
	jobs  *mongo.Collection
	locks *mongo.Collection
	tasks taskBudgetStore
}

func NewJobRepo(jobs, locks *mongo.Collection) *JobRepo {
	return &JobRepo{jobs: jobs, locks: locks}
}

type taskBudgetStore interface {
	BudgetStatus(ctx context.Context, originatorRunID string) (agent.RunBudgetStatus, error)
	TryConsumeRun(ctx context.Context, originatorRunID, userID, budgetKey string) (agent.RunBudgetStatus, bool, error)
}

func (r *JobRepo) SetTaskBudgetStore(tasks taskBudgetStore) {
	r.tasks = tasks
}

func (r *JobRepo) EnsureIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{Keys: bson.D{{Key: "job_id", Value: 1}}, Options: options.Index().SetUnique(true)},
		{Keys: bson.D{{Key: "parent_run_id", Value: 1}, {Key: "tool_call_id", Value: 1}}, Options: options.Index().SetUnique(true)},
		{Keys: bson.D{{Key: "status", Value: 1}, {Key: "lease_expires_at", Value: 1}, {Key: "created_at", Value: 1}}},
		{Keys: bson.D{{Key: "originator_run_id", Value: 1}, {Key: "status", Value: 1}}},
		{Keys: bson.D{{Key: "awaiting_parent_run_id", Value: 1}, {Key: "status", Value: 1}}},
		{Keys: bson.D{{Key: "callback_status", Value: 1}, {Key: "status", Value: 1}}},
		{Keys: bson.D{{Key: "parent_run_id", Value: 1}, {Key: "mode", Value: 1}, {Key: "delivered_at", Value: 1}, {Key: "created_at", Value: 1}}},
	}
	if _, err := r.jobs.Indexes().CreateMany(ctx, indexes); err != nil {
		return fmt.Errorf("job_repo: jobs indexes: %w", err)
	}
	if _, err := r.locks.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "lock_key", Value: 1}},
		Options: options.Index().SetUnique(true),
	}); err != nil {
		return fmt.Errorf("job_repo: lock index: %w", err)
	}
	return nil
}

// DispatchAgent idempotently creates the job for (parent_run_id, tool_call_id)
// and returns its dispatch result. A replay of the same key returns the EXISTING
// job unchanged — even if the request payload (task, mode, …) differs, the new
// payload is ignored rather than treated as a conflict. The run budget is
// consumed at most once, on first creation.
func (r *JobRepo) DispatchAgent(ctx context.Context, req agent.DispatchAgentRequest) (agent.DispatchAgentResult, error) {
	if req.ParentRunID == "" || req.ToolCallID == "" {
		return agent.DispatchAgentResult{}, errors.New("job_repo: parent_run_id and tool_call_id are required")
	}
	now := time.Now()
	jobID := deterministicJobID(req.ParentRunID, req.ToolCallID)
	callbackStatus := string(agent.CallbackStatusNone)
	if req.Mode == agent.JobModeBackground {
		callbackStatus = string(agent.CallbackStatusQueued)
	}
	filter := bson.M{"parent_run_id": req.ParentRunID, "tool_call_id": req.ToolCallID}
	var existing model.JobDocument
	err := r.jobs.FindOne(ctx, filter).Decode(&existing)
	if err == nil {
		return dispatchResultFromJob(existing), nil
	}
	if err != mongo.ErrNoDocuments {
		return agent.DispatchAgentResult{}, fmt.Errorf("job_repo: dispatch lookup: %w", err)
	}
	if err := r.consumeRunBudget(ctx, req); err != nil {
		return agent.DispatchAgentResult{}, err
	}
	update := bson.M{
		"$setOnInsert": bson.M{
			"_id":                  bson.NewObjectID(),
			"job_id":               jobID,
			"parent_run_id":        req.ParentRunID,
			"originator_run_id":    req.OriginatorRunID,
			"parent_thread_id":     req.ParentThreadID,
			"parent_agent_id":      req.ParentAgentID,
			"user_id":              req.UserID,
			"tool_call_id":         req.ToolCallID,
			"delegate_tool":        req.DelegateTool,
			"target_agent_id":      req.TargetAgentID,
			"task":                 req.Task,
			"mode":                 req.Mode,
			"callback_instruction": req.CallbackInstruction,
			"delegation_chain":     req.DelegationChain,
			"delegation_depth":     req.DelegationDepth,
			"status":               string(agent.JobStatusQueued),
			"callback_status":      callbackStatus,
			"created_at":           now,
		},
		"$set": bson.M{"updated_at": now},
	}
	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)
	var doc model.JobDocument
	if err := r.jobs.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			if lookupErr := r.jobs.FindOne(context.Background(), filter).Decode(&doc); lookupErr == nil {
				return dispatchResultFromJob(doc), nil
			}
		}
		return agent.DispatchAgentResult{}, fmt.Errorf("job_repo: dispatch upsert: %w", err)
	}
	return dispatchResultFromJob(doc), nil
}

func (r *JobRepo) consumeRunBudget(ctx context.Context, req agent.DispatchAgentRequest) error {
	if r.tasks == nil {
		return nil
	}
	if _, err := r.tasks.BudgetStatus(ctx, req.OriginatorRunID); err != nil {
		return fmt.Errorf("job_repo: budget status: %w", err)
	}
	status, ok, err := r.tasks.TryConsumeRun(ctx, req.OriginatorRunID, req.UserID, asyncBudgetKey(req.ParentRunID, req.ToolCallID))
	if err != nil {
		return fmt.Errorf("job_repo: consume run budget: %w", err)
	}
	if !ok {
		return agent.RunBudgetErrorFromStatus(status)
	}
	return nil
}

func asyncBudgetKey(parentRunID, toolCallID string) string {
	return "async:" + parentRunID + ":" + toolCallID
}

func dispatchResultFromJob(doc model.JobDocument) agent.DispatchAgentResult {
	return agent.DispatchAgentResult{
		JobID:        doc.JobID,
		Status:       doc.Status,
		Mode:         doc.Mode,
		DelegateTool: doc.DelegateTool,
	}
}

// toJobRecord translates the Mongo document into the storage-neutral record
// dispatcher's CoordinatorJobStore/WorkerJobStore ports deal in, so dispatcher
// never needs to import this package or the bson driver.
func toJobRecord(doc model.JobDocument) agent.JobRecord {
	return agent.JobRecord{
		JobID:               doc.JobID,
		ParentRunID:         doc.ParentRunID,
		OriginatorRunID:     doc.OriginatorRunID,
		ParentThreadID:      doc.ParentThreadID,
		ParentAgentID:       doc.ParentAgentID,
		UserID:              doc.UserID,
		ToolCallID:          doc.ToolCallID,
		DelegateTool:        doc.DelegateTool,
		TargetAgentID:       doc.TargetAgentID,
		Task:                doc.Task,
		Mode:                doc.Mode,
		CallbackInstruction: doc.CallbackInstruction,
		DelegationChain:     doc.DelegationChain,
		DelegationDepth:     doc.DelegationDepth,
		Status:              doc.Status,
		Output:              doc.Output,
		Error:               doc.Error,
		ChildRunID:          doc.ChildRunID,
		ChildThreadID:       doc.ChildThreadID,
		AwaitingParentRunID: doc.AwaitingParentRunID,
		AwaitToolCallID:     doc.AwaitToolCallID,
		AwaitingSince:       doc.AwaitingSince,
		DeliveredAt:         doc.DeliveredAt,
		DeliveredToolCallID: doc.DeliveredToolCallID,
		CallbackStatus:      doc.CallbackStatus,
		CallbackRunID:       doc.CallbackRunID,
		CallbackError:       doc.CallbackError,
		LeaseOwner:          doc.LeaseOwner,
		LeaseExpiresAt:      doc.LeaseExpiresAt,
		CreatedAt:           doc.CreatedAt,
		UpdatedAt:           doc.UpdatedAt,
		StartedAt:           doc.StartedAt,
		FinishedAt:          doc.FinishedAt,
	}
}

// fencedFilter adds a fencing condition on field to base: an empty runID
// means "never claimed yet" and matches either an absent or empty-string
// field (bson `omitempty` never stores an explicit empty string), while a
// non-empty runID must match exactly. Used by the terminal-write paths, which
// can fire for a job that was cancelled before ever being dispatched.
func fencedFilter(base bson.M, field, runID string) bson.M {
	if runID == "" {
		base["$or"] = bson.A{
			bson.M{field: bson.M{"$exists": false}},
			bson.M{field: ""},
		}
		return base
	}
	base[field] = runID
	return base
}

// AwaitJob returns the current state of an owned job. Pending is true iff the
// job has not reached a terminal status; a terminal job carries its Output/Error.
func (r *JobRepo) AwaitJob(ctx context.Context, req agent.AwaitJobRequest) (agent.AwaitJobResult, error) {
	doc, err := r.getOwnedJob(ctx, req.JobID, req.UserID, req.OriginatorRunID)
	if err != nil {
		return agent.AwaitJobResult{}, err
	}
	res := agent.AwaitJobResult{
		JobID:        doc.JobID,
		Status:       doc.Status,
		Output:       doc.Output,
		Error:        doc.Error,
		CreatedAt:    doc.CreatedAt,
		DelegateTool: doc.DelegateTool,
	}
	if !isJobTerminal(doc.Status) {
		res.Pending = true
	}
	return res, nil
}

func (r *JobRepo) PendingRequiredJobs(ctx context.Context, parentRunID, userID string) ([]agent.PendingRequiredJob, error) {
	filter := bson.M{
		"parent_run_id": parentRunID,
		"user_id":       userID,
		"mode":          agent.JobModeRequired,
		"delivered_at":  bson.M{"$exists": false},
	}
	opts := options.Find().SetSort(bson.D{{Key: "created_at", Value: 1}, {Key: "job_id", Value: 1}})
	cur, err := r.jobs.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("job_repo: pending required jobs: %w", err)
	}
	defer cur.Close(ctx)
	var out []agent.PendingRequiredJob
	for cur.Next(ctx) {
		var doc model.JobDocument
		if err := cur.Decode(&doc); err != nil {
			return nil, fmt.Errorf("job_repo: decode pending required job: %w", err)
		}
		out = append(out, agent.PendingRequiredJob{
			JobID:        doc.JobID,
			CreatedAt:    doc.CreatedAt,
			DelegateTool: doc.DelegateTool,
		})
	}
	return out, cur.Err()
}

func (r *JobRepo) MarkAwaiting(ctx context.Context, parentRunID string, awaits []agent.PendingAwait) error {
	now := time.Now()
	for _, a := range awaits {
		if a.JobID == "" {
			continue
		}
		awaitingSince := now
		if !a.CreatedAt.IsZero() {
			awaitingSince = a.CreatedAt
		}
		_, err := r.jobs.UpdateOne(ctx,
			bson.M{"job_id": a.JobID, "parent_run_id": parentRunID},
			bson.M{"$set": bson.M{
				"awaiting_parent_run_id": parentRunID,
				"await_tool_call_id":     a.AwaitToolCallID,
				"awaiting_since":         awaitingSince,
				"updated_at":             now,
			}},
		)
		if err != nil {
			return fmt.Errorf("job_repo: mark awaiting %s: %w", a.JobID, err)
		}
	}
	return nil
}

func (r *JobRepo) ResolveAwaits(ctx context.Context, parentRunID, userID string, awaits []agent.PendingAwait) ([]agent.AwaitJobResult, bool, error) {
	out := make([]agent.AwaitJobResult, 0, len(awaits))
	allTerminal := true
	for _, a := range awaits {
		doc, err := r.getOwnedJob(ctx, a.JobID, userID, "")
		if err != nil {
			return nil, false, err
		}
		if doc.ParentRunID != parentRunID && doc.AwaitingParentRunID != parentRunID {
			return nil, false, fmt.Errorf("job_repo: job %s is not awaitable by run %s", a.JobID, parentRunID)
		}
		res := agent.AwaitJobResult{
			JobID:        doc.JobID,
			Status:       doc.Status,
			Output:       doc.Output,
			Error:        doc.Error,
			CreatedAt:    doc.CreatedAt,
			DelegateTool: doc.DelegateTool,
		}
		if !isJobTerminal(doc.Status) {
			res.Pending = true
			allTerminal = false
		}
		out = append(out, res)
	}
	return out, allTerminal, nil
}

func (r *JobRepo) MarkDelivered(ctx context.Context, parentRunID, userID string, results []agent.AwaitJobResult, awaits []agent.PendingAwait) error {
	now := time.Now()
	callByJob := make(map[string]string, len(awaits))
	for _, a := range awaits {
		callByJob[a.JobID] = a.AwaitToolCallID
	}
	for _, res := range results {
		if res.Pending {
			continue
		}
		_, err := r.jobs.UpdateOne(ctx,
			bson.M{"job_id": res.JobID, "user_id": userID, "$or": bson.A{
				bson.M{"parent_run_id": parentRunID},
				bson.M{"awaiting_parent_run_id": parentRunID},
			}},
			bson.M{
				"$set": bson.M{
					"delivered_at":           now,
					"delivered_tool_call_id": callByJob[res.JobID],
					"updated_at":             now,
				},
				"$unset": bson.M{
					"awaiting_parent_run_id": "",
					"await_tool_call_id":     "",
					"awaiting_since":         "",
				},
			},
		)
		if err != nil {
			return fmt.Errorf("job_repo: mark delivered %s: %w", res.JobID, err)
		}
	}
	return nil
}

func (r *JobRepo) FindQueueCandidates(ctx context.Context, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	now := time.Now()
	filter := bson.M{
		"$or": bson.A{
			bson.M{"status": string(agent.JobStatusQueued)},
			bson.M{
				"status":           string(agent.JobStatusStarting),
				"lease_expires_at": bson.M{"$lte": now},
			},
		},
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: 1}, {Key: "job_id", Value: 1}}).
		SetLimit(int64(limit))
	cur, err := r.jobs.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find queue candidates: %w", err)
	}
	defer cur.Close(ctx)
	var out []agent.JobRecord
	for cur.Next(ctx) {
		var doc model.JobDocument
		if err := cur.Decode(&doc); err != nil {
			return nil, fmt.Errorf("job_repo: decode queue candidate: %w", err)
		}
		out = append(out, toJobRecord(doc))
	}
	return out, cur.Err()
}

func (r *JobRepo) CountActiveForOriginator(ctx context.Context, originatorRunID string) (int64, error) {
	now := time.Now()
	count, err := r.jobs.CountDocuments(ctx, bson.M{
		"originator_run_id": originatorRunID,
		"$or": bson.A{
			bson.M{"status": string(agent.JobStatusRunning)},
			bson.M{
				"status":           string(agent.JobStatusStarting),
				"lease_expires_at": bson.M{"$gt": now},
			},
		},
	})
	if err != nil {
		return 0, fmt.Errorf("job_repo: count active: %w", err)
	}
	return count, nil
}

func (r *JobRepo) FindExpiredRunningJobs(ctx context.Context, before time.Time, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	cur, err := r.jobs.Find(ctx,
		bson.M{
			"status": string(agent.JobStatusRunning),
			"$or": bson.A{
				bson.M{"lease_expires_at": bson.M{"$exists": false}},
				bson.M{"lease_expires_at": bson.M{"$lte": before}},
			},
		},
		options.Find().SetSort(bson.D{{Key: "updated_at", Value: 1}, {Key: "job_id", Value: 1}}).SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find expired running jobs: %w", err)
	}
	defer cur.Close(ctx)
	var out []agent.JobRecord
	for cur.Next(ctx) {
		var doc model.JobDocument
		if err := cur.Decode(&doc); err != nil {
			return nil, fmt.Errorf("job_repo: decode expired running job: %w", err)
		}
		out = append(out, toJobRecord(doc))
	}
	return out, cur.Err()
}

func (r *JobRepo) FindExpiredRunningCallbacks(ctx context.Context, before time.Time, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	cur, err := r.jobs.Find(ctx,
		bson.M{
			"callback_status": string(agent.CallbackStatusRunning),
			"$or": bson.A{
				bson.M{"lease_expires_at": bson.M{"$exists": false}},
				bson.M{"lease_expires_at": bson.M{"$lte": before}},
			},
		},
		options.Find().SetSort(bson.D{{Key: "updated_at", Value: 1}, {Key: "job_id", Value: 1}}).SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find expired running callbacks: %w", err)
	}
	defer cur.Close(ctx)
	var out []agent.JobRecord
	for cur.Next(ctx) {
		var doc model.JobDocument
		if err := cur.Decode(&doc); err != nil {
			return nil, fmt.Errorf("job_repo: decode expired running callback: %w", err)
		}
		out = append(out, toJobRecord(doc))
	}
	return out, cur.Err()
}

func (r *JobRepo) HasRunningTargetJob(ctx context.Context, originatorRunID, targetAgentID, excludeJobID string) (bool, error) {
	filter := bson.M{
		"originator_run_id": originatorRunID,
		"target_agent_id":   targetAgentID,
		"status":            string(agent.JobStatusRunning),
	}
	if excludeJobID != "" {
		filter["job_id"] = bson.M{"$ne": excludeJobID}
	}
	count, err := r.jobs.CountDocuments(ctx, filter)
	if err != nil {
		return false, fmt.Errorf("job_repo: has running target job: %w", err)
	}
	return count > 0, nil
}

func (r *JobRepo) HasRunningCallback(ctx context.Context, parentThreadID, excludeJobID string) (bool, error) {
	filter := bson.M{
		"parent_thread_id": parentThreadID,
		"callback_status":  string(agent.CallbackStatusRunning),
	}
	if excludeJobID != "" {
		filter["job_id"] = bson.M{"$ne": excludeJobID}
	}
	count, err := r.jobs.CountDocuments(ctx, filter)
	if err != nil {
		return false, fmt.Errorf("job_repo: has running callback: %w", err)
	}
	return count > 0, nil
}

func (r *JobRepo) AcquireLock(ctx context.Context, lockType, lockKey, activeJobID, activeRunID, owner string, ttl time.Duration) (bool, error) {
	now := time.Now()
	expires := now.Add(ttl)
	// The "same job" fast path also requires the SAME owner already holding
	// the lock — otherwise a second coordinator could silently steal an
	// unexpired lease just by knowing the job id. Genuine expiry is the only
	// other way in.
	filter := bson.M{"lock_key": lockKey, "$or": bson.A{
		bson.M{"lease_expires_at": bson.M{"$lte": now}},
		bson.M{"active_job_id": activeJobID, "lease_owner": owner},
	}}
	update := bson.M{
		"$set": bson.M{
			"lock_type":        lockType,
			"active_job_id":    activeJobID,
			"active_run_id":    activeRunID,
			"lease_owner":      owner,
			"lease_expires_at": expires,
			"updated_at":       now,
		},
		"$setOnInsert": bson.M{
			"_id":        bson.NewObjectID(),
			"lock_key":   lockKey,
			"created_at": now,
		},
	}
	var doc model.JobLockDocument
	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)
	err := r.locks.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return false, nil
		}
		if mongo.IsDuplicateKeyError(err) {
			return false, nil
		}
		return false, fmt.Errorf("job_repo: acquire lock: %w", err)
	}
	return doc.ActiveJobID == activeJobID && doc.LeaseOwner == owner, nil
}

func (r *JobRepo) ReleaseLock(ctx context.Context, lockKey, activeJobID, owner string) error {
	_, err := r.locks.DeleteOne(ctx, bson.M{"lock_key": lockKey, "active_job_id": activeJobID, "lease_owner": owner})
	if err != nil {
		return fmt.Errorf("job_repo: release lock: %w", err)
	}
	return nil
}

func (r *JobRepo) ClaimJobStarting(ctx context.Context, jobID, owner string, lease time.Duration) (agent.JobRecord, bool, error) {
	now := time.Now()
	leaseExpires := now.Add(lease)
	filter := bson.M{
		"job_id": jobID,
		"$or": bson.A{
			bson.M{"status": string(agent.JobStatusQueued)},
			bson.M{
				"status":           string(agent.JobStatusStarting),
				"lease_expires_at": bson.M{"$lte": now},
			},
		},
	}
	update := bson.M{"$set": bson.M{
		"status":           string(agent.JobStatusStarting),
		"lease_owner":      owner,
		"lease_expires_at": leaseExpires,
		"updated_at":       now,
	}}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var doc model.JobDocument
	err := r.jobs.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return agent.JobRecord{}, false, nil
	}
	if err != nil {
		return agent.JobRecord{}, false, fmt.Errorf("job_repo: claim starting: %w", err)
	}
	return toJobRecord(doc), true, nil
}

// MarkJobDispatched requires the claim owner: without it, a claimant whose
// lease already expired and got reclaimed by someone else could still
// clobber the reclaimer's dispatch with its own stale child run. Reports
// whether the CAS actually applied — a nil error alone does not mean it did
// (zero matched rows is not an error), so the caller must check applied
// before publishing the dispatch.
func (r *JobRepo) MarkJobDispatched(ctx context.Context, jobID, owner, childRunID, childThreadID string) (bool, error) {
	now := time.Now()
	res, err := r.jobs.UpdateOne(ctx,
		bson.M{"job_id": jobID, "status": string(agent.JobStatusStarting), "lease_owner": owner},
		bson.M{"$set": bson.M{
			"child_run_id":    childRunID,
			"child_thread_id": childThreadID,
			"status":          string(agent.JobStatusRunning),
			"started_at":      now,
			"updated_at":      now,
		}},
	)
	if err != nil {
		return false, fmt.Errorf("job_repo: mark dispatched: %w", err)
	}
	return res.MatchedCount == 1, nil
}

// MarkClaimedJobFailed terminates a job that was claimed (status=starting)
// but never reached MarkJobDispatched — child_run_id is not yet persisted at
// this point, so markJobTerminal's child-run fencing can never match it.
// Fences on the claim owner instead, the same predicate MarkJobDispatched
// itself uses, and releases the target lock the coordinator is still
// holding.
func (r *JobRepo) MarkClaimedJobFailed(ctx context.Context, jobID, owner, errText string) (bool, error) {
	now := time.Now()
	var doc model.JobDocument
	opts := options.FindOneAndUpdate().SetReturnDocument(options.Before)
	err := r.jobs.FindOneAndUpdate(ctx,
		bson.M{"job_id": jobID, "status": string(agent.JobStatusStarting), "lease_owner": owner},
		bson.M{
			"$set":   bson.M{"status": string(agent.JobStatusFailed), "error": errText, "finished_at": now, "updated_at": now},
			"$unset": bson.M{"lease_owner": "", "lease_expires_at": ""},
		},
		opts,
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("job_repo: mark claimed job failed: %w", err)
	}
	if err := r.ReleaseLock(ctx, targetLockKey(doc.OriginatorRunID, doc.TargetAgentID), jobID, owner); err != nil {
		return true, err
	}
	return true, nil
}

// RefreshJobLease fences on childRunID: once it no longer matches the job's
// current child_run_id (reclaimed and redispatched under a new run), the
// heartbeat stops silently extending both the job's lease and the target
// lock's lease on its behalf.
func (r *JobRepo) RefreshJobLease(ctx context.Context, jobID, childRunID, originatorRunID, targetAgentID, owner string, ttl time.Duration) error {
	now := time.Now()
	expires := now.Add(ttl)
	if ttl <= 0 {
		expires = now
	}
	res, err := r.jobs.UpdateOne(ctx,
		bson.M{"job_id": jobID, "child_run_id": childRunID, "status": bson.M{"$in": bson.A{
			string(agent.JobStatusStarting), string(agent.JobStatusRunning),
		}}},
		bson.M{"$set": bson.M{
			"lease_owner":      owner,
			"lease_expires_at": expires,
			"updated_at":       now,
		}},
	)
	if err != nil {
		return fmt.Errorf("job_repo: refresh job lease: %w", err)
	}
	if res.MatchedCount == 0 {
		return fmt.Errorf("job_repo: refresh job lease: job %s is no longer owned by run %s", jobID, childRunID)
	}
	_, err = r.locks.UpdateOne(ctx,
		bson.M{"lock_key": targetLockKey(originatorRunID, targetAgentID), "active_job_id": jobID},
		bson.M{"$set": bson.M{
			"lease_owner":      owner,
			"lease_expires_at": expires,
			"updated_at":       now,
		}},
	)
	if err != nil {
		return fmt.Errorf("job_repo: refresh target lock lease: %w", err)
	}
	return nil
}

func (r *JobRepo) MarkJobSucceeded(ctx context.Context, jobID, childRunID, output string) (bool, error) {
	return r.markJobTerminal(ctx, jobID, childRunID, string(agent.JobStatusSucceeded), output, "")
}

func (r *JobRepo) MarkJobFailed(ctx context.Context, jobID, childRunID, errText string) (bool, error) {
	return r.markJobTerminal(ctx, jobID, childRunID, string(agent.JobStatusFailed), "", errText)
}

func (r *JobRepo) MarkJobCancelled(ctx context.Context, jobID, childRunID, errText string) (bool, error) {
	return r.markJobTerminal(ctx, jobID, childRunID, string(agent.JobStatusCancelled), "", errText)
}

// markJobTerminal fences on childRunID (empty means "never dispatched") so a
// zombie worker from a reclaimed dispatch attempt can't clobber the outcome
// of the attempt that superseded it. The lock is released using the lease
// owner captured from BEFORE this update — the update itself unsets it — so
// whichever owner (coordinator, pre-dispatch, or the worker's heartbeat,
// post-dispatch) currently holds the target lock gets it released correctly.
// Reports whether the fenced write applied — the caller must not notify
// anyone of a terminal state that never actually took effect.
func (r *JobRepo) markJobTerminal(ctx context.Context, jobID, childRunID, status, output, errText string) (bool, error) {
	now := time.Now()
	set := bson.M{
		"status":      status,
		"output":      output,
		"error":       errText,
		"finished_at": now,
		"updated_at":  now,
	}
	filter := fencedFilter(bson.M{
		"job_id": jobID,
		"status": bson.M{"$in": bson.A{
			string(agent.JobStatusQueued), string(agent.JobStatusStarting), string(agent.JobStatusRunning),
		}},
	}, "child_run_id", childRunID)
	var doc model.JobDocument
	opts := options.FindOneAndUpdate().SetReturnDocument(options.Before)
	err := r.jobs.FindOneAndUpdate(ctx, filter,
		bson.M{"$set": set, "$unset": bson.M{"lease_owner": "", "lease_expires_at": ""}},
		opts,
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("job_repo: mark job terminal: %w", err)
	}
	if err := r.ReleaseLock(ctx, targetLockKey(doc.OriginatorRunID, doc.TargetAgentID), jobID, doc.LeaseOwner); err != nil {
		return true, err
	}
	return true, nil
}

func (r *JobRepo) GetJob(ctx context.Context, jobID string) (model.JobDocument, error) {
	var doc model.JobDocument
	err := r.jobs.FindOne(ctx, bson.M{"job_id": jobID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return model.JobDocument{}, fmt.Errorf("job_repo: job not found: %s", jobID)
	}
	if err != nil {
		return model.JobDocument{}, fmt.Errorf("job_repo: get job: %w", err)
	}
	return doc, nil
}

// FindReadyWaitingRunIDs: a run is ready iff every one of its awaiting,
// undelivered jobs is terminal. The full matching set is scanned before
// grouping — truncating the raw cursor first (as a naive limit*10 would) can
// split a run's awaiting-job set across the truncation boundary and falsely
// report it ready before every job is actually seen. limit applies only to
// the final ready-run-id list, which is sorted for determinism.
func (r *JobRepo) FindReadyWaitingRunIDs(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	filter := bson.M{
		"awaiting_parent_run_id": bson.M{"$exists": true, "$ne": ""},
		"delivered_at":           bson.M{"$exists": false},
	}
	cur, err := r.jobs.Find(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find awaiting jobs: %w", err)
	}
	defer cur.Close(ctx)
	ready := map[string]bool{}
	for cur.Next(ctx) {
		var doc model.JobDocument
		if err := cur.Decode(&doc); err != nil {
			return nil, fmt.Errorf("job_repo: decode awaiting job: %w", err)
		}
		runID := doc.AwaitingParentRunID
		if _, seen := ready[runID]; !seen {
			ready[runID] = true
		}
		if !isJobTerminal(doc.Status) {
			ready[runID] = false
		}
	}
	if err := cur.Err(); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(ready))
	for runID, isReady := range ready {
		if isReady {
			out = append(out, runID)
		}
	}
	sort.Strings(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (r *JobRepo) FindQueuedCallbacks(ctx context.Context, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	cur, err := r.jobs.Find(ctx,
		bson.M{
			"mode":            agent.JobModeBackground,
			"status":          bson.M{"$in": bson.A{string(agent.JobStatusSucceeded), string(agent.JobStatusFailed), string(agent.JobStatusCancelled)}},
			"callback_status": string(agent.CallbackStatusQueued),
		},
		options.Find().SetSort(bson.D{{Key: "finished_at", Value: 1}, {Key: "job_id", Value: 1}}).SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find queued callbacks: %w", err)
	}
	defer cur.Close(ctx)
	var out []agent.JobRecord
	for cur.Next(ctx) {
		var doc model.JobDocument
		if err := cur.Decode(&doc); err != nil {
			return nil, fmt.Errorf("job_repo: decode callback: %w", err)
		}
		out = append(out, toJobRecord(doc))
	}
	return out, cur.Err()
}

// MarkCallbackRunning reports whether it actually claimed the callback: the
// caller must release its lock and skip creating the callback run on false,
// rather than assuming success.
func (r *JobRepo) MarkCallbackRunning(ctx context.Context, jobID, callbackRunID, owner string, lease time.Duration) (bool, error) {
	now := time.Now()
	leaseExpires := now.Add(lease)
	res, err := r.jobs.UpdateOne(ctx,
		bson.M{"job_id": jobID, "callback_status": string(agent.CallbackStatusQueued)},
		bson.M{"$set": bson.M{
			"callback_status":  string(agent.CallbackStatusRunning),
			"callback_run_id":  callbackRunID,
			"lease_owner":      owner,
			"lease_expires_at": leaseExpires,
			"updated_at":       now,
		}},
	)
	if err != nil {
		return false, fmt.Errorf("job_repo: mark callback running: %w", err)
	}
	return res.MatchedCount == 1, nil
}

// RefreshCallbackLease fences on callbackRunID the same way RefreshJobLease
// fences on childRunID: once it no longer matches, the heartbeat stops
// extending a lease that's since been reclaimed by a new callback attempt.
func (r *JobRepo) RefreshCallbackLease(ctx context.Context, jobID, callbackRunID, parentThreadID, owner string, ttl time.Duration) error {
	now := time.Now()
	expires := now.Add(ttl)
	if ttl <= 0 {
		expires = now
	}
	res, err := r.jobs.UpdateOne(ctx,
		bson.M{"job_id": jobID, "callback_run_id": callbackRunID, "callback_status": string(agent.CallbackStatusRunning)},
		bson.M{"$set": bson.M{
			"lease_owner":      owner,
			"lease_expires_at": expires,
			"updated_at":       now,
		}},
	)
	if err != nil {
		return fmt.Errorf("job_repo: refresh callback lease: %w", err)
	}
	if res.MatchedCount == 0 {
		return fmt.Errorf("job_repo: refresh callback lease: job %s callback is no longer owned by run %s", jobID, callbackRunID)
	}
	_, err = r.locks.UpdateOne(ctx,
		bson.M{"lock_key": callbackLockKey(parentThreadID), "active_job_id": jobID},
		bson.M{"$set": bson.M{
			"lease_owner":      owner,
			"lease_expires_at": expires,
			"updated_at":       now,
		}},
	)
	if err != nil {
		return fmt.Errorf("job_repo: refresh callback lock lease: %w", err)
	}
	return nil
}

func (r *JobRepo) MarkCallbackCompleted(ctx context.Context, jobID, callbackRunID string) error {
	return r.markCallbackTerminal(ctx, jobID, callbackRunID, string(agent.CallbackStatusCompleted), "")
}

func (r *JobRepo) MarkCallbackFailed(ctx context.Context, jobID, callbackRunID, errText string) error {
	return r.markCallbackTerminal(ctx, jobID, callbackRunID, string(agent.CallbackStatusFailed), errText)
}

func (r *JobRepo) MarkCallbackCancelled(ctx context.Context, jobID, callbackRunID, errText string) error {
	return r.markCallbackTerminal(ctx, jobID, callbackRunID, string(agent.CallbackStatusCancelled), errText)
}

// callbackFenceStatus returns the callback_status a terminal write must
// currently observe to apply: "queued" for the pre-start, empty-run-id
// cancellation path, "running" once a specific callback run has claimed it.
// Without this, a terminal write fenced only on callback_run_id would still
// match after the callback already reached ITS OWN terminal state (the run
// id doesn't change once set), letting a worker completion race the expiry
// coordinator into last-writer-wins — completed flipping back to failed, or
// vice versa.
func callbackFenceStatus(callbackRunID string) string {
	if callbackRunID == "" {
		return string(agent.CallbackStatusQueued)
	}
	return string(agent.CallbackStatusRunning)
}

// markCallbackTerminal writes to callback_error, a field distinct from the
// job's own Error — a callback failure must never overwrite the job's own
// outcome, which AwaitJob/ResolveAwaits callers read independently of
// whether a background callback later succeeded or failed.
func (r *JobRepo) markCallbackTerminal(ctx context.Context, jobID, callbackRunID, status, errText string) error {
	now := time.Now()
	filter := fencedFilter(bson.M{
		"job_id":          jobID,
		"callback_status": callbackFenceStatus(callbackRunID),
	}, "callback_run_id", callbackRunID)
	res, err := r.jobs.UpdateOne(ctx, filter,
		bson.M{"$set": bson.M{
			"callback_status": status,
			"callback_error":  errText,
			"updated_at":      now,
		}},
	)
	if err != nil {
		return fmt.Errorf("job_repo: mark callback terminal: %w", err)
	}
	// Only release the lock when THIS call's fenced write actually applied —
	// otherwise a mismatched/stale callbackRunID could read back and release
	// whatever lock a DIFFERENT, currently-legitimate callback attempt holds.
	if res.MatchedCount == 0 {
		return nil
	}
	doc, err := r.GetJob(ctx, jobID)
	if err == nil {
		_ = r.ReleaseLock(ctx, callbackLockKey(doc.ParentThreadID), jobID, doc.LeaseOwner)
	}
	return nil
}

func (r *JobRepo) getOwnedJob(ctx context.Context, jobID, userID, originatorRunID string) (model.JobDocument, error) {
	filter := bson.M{"job_id": jobID, "user_id": userID}
	if originatorRunID != "" {
		filter["originator_run_id"] = originatorRunID
	}
	var doc model.JobDocument
	err := r.jobs.FindOne(ctx, filter).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return model.JobDocument{}, fmt.Errorf("job_repo: job not found or not owned: %s", jobID)
	}
	if err != nil {
		return model.JobDocument{}, fmt.Errorf("job_repo: get owned job: %w", err)
	}
	return doc, nil
}

func deterministicJobID(parentRunID, toolCallID string) string {
	sum := sha256.Sum256([]byte(parentRunID + "\x00" + toolCallID))
	return "job_" + hex.EncodeToString(sum[:12])
}

func isJobTerminal(status string) bool {
	return status == string(agent.JobStatusSucceeded) ||
		status == string(agent.JobStatusFailed) ||
		status == string(agent.JobStatusCancelled)
}

func targetLockKey(originatorRunID, targetAgentID string) string {
	return "target:" + originatorRunID + ":" + targetAgentID
}

func callbackLockKey(threadID string) string {
	return "callback_thread:" + threadID
}

func TargetLockKey(originatorRunID, targetAgentID string) string {
	return targetLockKey(originatorRunID, targetAgentID)
}

func CallbackLockKey(threadID string) string {
	return callbackLockKey(threadID)
}
