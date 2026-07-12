package sqliterepo

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"sort"
	"time"

	"backend/agent"
)

type JobRepo struct {
	db    *sql.DB
	tasks taskBudgetStore
}

func NewJobRepo(db *sql.DB) *JobRepo { return &JobRepo{db: db} }

type taskBudgetStore interface {
	BudgetStatus(ctx context.Context, originatorRunID string) (agent.RunBudgetStatus, error)
	TryConsumeRun(ctx context.Context, originatorRunID, userID, budgetKey string) (agent.RunBudgetStatus, bool, error)
}

func (r *JobRepo) SetTaskBudgetStore(tasks taskBudgetStore) {
	r.tasks = tasks
}

const jobColumns = `job_id, parent_run_id, originator_run_id, parent_thread_id, parent_agent_id, user_id,
tool_call_id, delegate_tool, target_agent_id, task, mode, callback_instruction, delegation_chain_json,
delegation_depth, status, output, error, child_run_id, child_thread_id, awaiting_parent_run_id,
await_tool_call_id, awaiting_since, delivered_at, delivered_tool_call_id, callback_status, callback_run_id,
callback_error, lease_owner, lease_expires_at, created_at, updated_at, started_at, finished_at`

func scanJob(s rowScanner) (agent.JobRecord, error) {
	var (
		rec                        agent.JobRecord
		delegationChainJSON        sql.NullString
		awaitingSince, deliveredAt sql.NullInt64
		leaseExpiresAt             sql.NullInt64
		createdAt, updatedAt       int64
		startedAt, finishedAt      sql.NullInt64
	)
	err := s.Scan(
		&rec.JobID, &rec.ParentRunID, &rec.OriginatorRunID, &rec.ParentThreadID, &rec.ParentAgentID, &rec.UserID,
		&rec.ToolCallID, &rec.DelegateTool, &rec.TargetAgentID, &rec.Task, &rec.Mode, &rec.CallbackInstruction,
		&delegationChainJSON, &rec.DelegationDepth, &rec.Status, &rec.Output, &rec.Error, &rec.ChildRunID,
		&rec.ChildThreadID, &rec.AwaitingParentRunID, &rec.AwaitToolCallID, &awaitingSince, &deliveredAt,
		&rec.DeliveredToolCallID, &rec.CallbackStatus, &rec.CallbackRunID, &rec.CallbackError, &rec.LeaseOwner,
		&leaseExpiresAt, &createdAt, &updatedAt, &startedAt, &finishedAt,
	)
	if err != nil {
		return agent.JobRecord{}, err
	}
	if err := decodeJSON(delegationChainJSON, &rec.DelegationChain); err != nil {
		return agent.JobRecord{}, fmt.Errorf("delegation chain: %w", err)
	}
	rec.AwaitingSince = timeFromNull(awaitingSince)
	rec.DeliveredAt = timeFromNull(deliveredAt)
	rec.LeaseExpiresAt = timeFromNull(leaseExpiresAt)
	rec.CreatedAt = timeFromUnixNano(createdAt)
	rec.UpdatedAt = timeFromUnixNano(updatedAt)
	rec.StartedAt = timeFromUnixNano(startedAt.Int64)
	rec.FinishedAt = timeFromUnixNano(finishedAt.Int64)
	return rec, nil
}

func scanJobRows(rows *sql.Rows, op string) ([]agent.JobRecord, error) {
	var out []agent.JobRecord
	for rows.Next() {
		rec, err := scanJob(rows)
		if err != nil {
			return nil, fmt.Errorf("job_repo: %s: decode: %w", op, err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("job_repo: %s: %w", op, err)
	}
	return out, nil
}

// DispatchAgent idempotently creates the job for (parent_run_id, tool_call_id)
// and returns its dispatch result. A replay of the same key returns the
// EXISTING job unchanged — even if the request payload (task, mode, …)
// differs, the new payload is ignored rather than treated as a conflict. The
// run budget is consumed at most once, on first creation.
func (r *JobRepo) DispatchAgent(ctx context.Context, req agent.DispatchAgentRequest) (agent.DispatchAgentResult, error) {
	if req.ParentRunID == "" || req.ToolCallID == "" {
		return agent.DispatchAgentResult{}, fmt.Errorf("job_repo: parent_run_id and tool_call_id are required")
	}
	existing, err := r.findByDispatchKey(ctx, req.ParentRunID, req.ToolCallID)
	if err != nil {
		return agent.DispatchAgentResult{}, err
	}
	if existing != nil {
		return dispatchResultFromRecord(*existing), nil
	}
	if err := r.consumeRunBudget(ctx, req); err != nil {
		return agent.DispatchAgentResult{}, err
	}
	now := unixNano(time.Now())
	jobID := deterministicJobID(req.ParentRunID, req.ToolCallID)
	callbackStatus := string(agent.CallbackStatusNone)
	if req.Mode == agent.JobModeBackground {
		callbackStatus = string(agent.CallbackStatusQueued)
	}
	chainJSON, err := encodeJSON(req.DelegationChain)
	if err != nil {
		return agent.DispatchAgentResult{}, fmt.Errorf("job_repo: encode delegation chain: %w", err)
	}
	var status, mode, delegateTool string
	err = r.db.QueryRowContext(ctx, `
INSERT INTO jobs(job_id, parent_run_id, originator_run_id, parent_thread_id, parent_agent_id, user_id,
    tool_call_id, delegate_tool, target_agent_id, task, mode, callback_instruction, delegation_chain_json,
    delegation_depth, status, callback_status, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(parent_run_id, tool_call_id) DO UPDATE SET updated_at = excluded.updated_at
RETURNING job_id, status, mode, delegate_tool`,
		jobID, req.ParentRunID, req.OriginatorRunID, req.ParentThreadID, req.ParentAgentID, req.UserID,
		req.ToolCallID, req.DelegateTool, req.TargetAgentID, req.Task, req.Mode, req.CallbackInstruction,
		chainJSON, req.DelegationDepth, string(agent.JobStatusQueued), callbackStatus, now, now,
	).Scan(&jobID, &status, &mode, &delegateTool)
	if err != nil {
		return agent.DispatchAgentResult{}, fmt.Errorf("job_repo: dispatch upsert: %w", err)
	}
	return agent.DispatchAgentResult{JobID: jobID, Status: status, Mode: mode, DelegateTool: delegateTool}, nil
}

func (r *JobRepo) findByDispatchKey(ctx context.Context, parentRunID, toolCallID string) (*agent.JobRecord, error) {
	rec, err := scanJob(r.db.QueryRowContext(ctx,
		`SELECT `+jobColumns+` FROM jobs WHERE parent_run_id = ? AND tool_call_id = ?`, parentRunID, toolCallID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("job_repo: dispatch lookup: %w", err)
	}
	return &rec, nil
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

func dispatchResultFromRecord(rec agent.JobRecord) agent.DispatchAgentResult {
	return agent.DispatchAgentResult{JobID: rec.JobID, Status: rec.Status, Mode: rec.Mode, DelegateTool: rec.DelegateTool}
}

// AwaitJob returns the current state of an owned job. Pending is true iff the
// job has not reached a terminal status; a terminal job carries its Output/Error.
func (r *JobRepo) AwaitJob(ctx context.Context, req agent.AwaitJobRequest) (agent.AwaitJobResult, error) {
	rec, err := r.getOwnedJob(ctx, req.JobID, req.UserID, req.OriginatorRunID)
	if err != nil {
		return agent.AwaitJobResult{}, err
	}
	res := agent.AwaitJobResult{
		JobID: rec.JobID, Status: rec.Status, Output: rec.Output, Error: rec.Error,
		CreatedAt: rec.CreatedAt, DelegateTool: rec.DelegateTool,
	}
	if !isJobTerminal(rec.Status) {
		res.Pending = true
	}
	return res, nil
}

func (r *JobRepo) getOwnedJob(ctx context.Context, jobID, userID, originatorRunID string) (agent.JobRecord, error) {
	query := `SELECT ` + jobColumns + ` FROM jobs WHERE job_id = ? AND user_id = ?`
	args := []any{jobID, userID}
	if originatorRunID != "" {
		query += ` AND originator_run_id = ?`
		args = append(args, originatorRunID)
	}
	rec, err := scanJob(r.db.QueryRowContext(ctx, query, args...))
	if err == sql.ErrNoRows {
		return agent.JobRecord{}, fmt.Errorf("job_repo: job not found or not owned: %s", jobID)
	}
	if err != nil {
		return agent.JobRecord{}, fmt.Errorf("job_repo: get owned job: %w", err)
	}
	return rec, nil
}

func (r *JobRepo) PendingRequiredJobs(ctx context.Context, parentRunID, userID string) ([]agent.PendingRequiredJob, error) {
	rows, err := r.db.QueryContext(ctx, `
SELECT job_id, created_at, delegate_tool FROM jobs
WHERE parent_run_id = ? AND user_id = ? AND mode = ? AND delivered_at IS NULL
ORDER BY created_at ASC, job_id ASC`, parentRunID, userID, agent.JobModeRequired)
	if err != nil {
		return nil, fmt.Errorf("job_repo: pending required jobs: %w", err)
	}
	defer rows.Close()
	var out []agent.PendingRequiredJob
	for rows.Next() {
		var p agent.PendingRequiredJob
		var createdAt int64
		if err := rows.Scan(&p.JobID, &createdAt, &p.DelegateTool); err != nil {
			return nil, fmt.Errorf("job_repo: decode pending required job: %w", err)
		}
		p.CreatedAt = timeFromUnixNano(createdAt)
		out = append(out, p)
	}
	return out, rows.Err()
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
		if _, err := r.db.ExecContext(ctx, `
UPDATE jobs SET awaiting_parent_run_id = ?, await_tool_call_id = ?, awaiting_since = ?, updated_at = ?
WHERE job_id = ? AND parent_run_id = ?`,
			parentRunID, a.AwaitToolCallID, unixNano(awaitingSince), unixNano(now), a.JobID, parentRunID); err != nil {
			return fmt.Errorf("job_repo: mark awaiting %s: %w", a.JobID, err)
		}
	}
	return nil
}

func (r *JobRepo) ResolveAwaits(ctx context.Context, parentRunID, userID string, awaits []agent.PendingAwait) ([]agent.AwaitJobResult, bool, error) {
	out := make([]agent.AwaitJobResult, 0, len(awaits))
	allTerminal := true
	for _, a := range awaits {
		rec, err := r.getOwnedJob(ctx, a.JobID, userID, "")
		if err != nil {
			return nil, false, err
		}
		if rec.ParentRunID != parentRunID && rec.AwaitingParentRunID != parentRunID {
			return nil, false, fmt.Errorf("job_repo: job %s is not awaitable by run %s", a.JobID, parentRunID)
		}
		res := agent.AwaitJobResult{
			JobID: rec.JobID, Status: rec.Status, Output: rec.Output, Error: rec.Error,
			CreatedAt: rec.CreatedAt, DelegateTool: rec.DelegateTool,
		}
		if !isJobTerminal(rec.Status) {
			res.Pending = true
			allTerminal = false
		}
		out = append(out, res)
	}
	return out, allTerminal, nil
}

func (r *JobRepo) MarkDelivered(ctx context.Context, parentRunID, userID string, results []agent.AwaitJobResult, awaits []agent.PendingAwait) error {
	now := unixNano(time.Now())
	callByJob := make(map[string]string, len(awaits))
	for _, a := range awaits {
		callByJob[a.JobID] = a.AwaitToolCallID
	}
	for _, res := range results {
		if res.Pending {
			continue
		}
		if _, err := r.db.ExecContext(ctx, `
UPDATE jobs SET delivered_at = ?, delivered_tool_call_id = ?, awaiting_parent_run_id = '', await_tool_call_id = '',
    awaiting_since = NULL, updated_at = ?
WHERE job_id = ? AND user_id = ? AND (parent_run_id = ? OR awaiting_parent_run_id = ?)`,
			now, callByJob[res.JobID], now, res.JobID, userID, parentRunID, parentRunID); err != nil {
			return fmt.Errorf("job_repo: mark delivered %s: %w", res.JobID, err)
		}
	}
	return nil
}

func (r *JobRepo) FindQueueCandidates(ctx context.Context, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	now := unixNano(time.Now())
	rows, err := r.db.QueryContext(ctx, `
SELECT `+jobColumns+` FROM jobs
WHERE status = ? OR (status = ? AND lease_expires_at <= ?)
ORDER BY created_at ASC, job_id ASC
LIMIT ?`, string(agent.JobStatusQueued), string(agent.JobStatusStarting), now, limit)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find queue candidates: %w", err)
	}
	defer rows.Close()
	return scanJobRows(rows, "find queue candidates")
}

func (r *JobRepo) CountActiveForOriginator(ctx context.Context, originatorRunID string) (int64, error) {
	now := unixNano(time.Now())
	var count int64
	err := r.db.QueryRowContext(ctx, `
SELECT count(*) FROM jobs
WHERE originator_run_id = ? AND (status = ? OR (status = ? AND lease_expires_at > ?))`,
		originatorRunID, string(agent.JobStatusRunning), string(agent.JobStatusStarting), now).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("job_repo: count active: %w", err)
	}
	return count, nil
}

func (r *JobRepo) FindExpiredRunningJobs(ctx context.Context, before time.Time, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx, `
SELECT `+jobColumns+` FROM jobs
WHERE status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
ORDER BY updated_at ASC, job_id ASC
LIMIT ?`, string(agent.JobStatusRunning), unixNano(before), limit)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find expired running jobs: %w", err)
	}
	defer rows.Close()
	return scanJobRows(rows, "find expired running jobs")
}

func (r *JobRepo) FindExpiredRunningCallbacks(ctx context.Context, before time.Time, limit int) ([]agent.JobRecord, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx, `
SELECT `+jobColumns+` FROM jobs
WHERE callback_status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
ORDER BY updated_at ASC, job_id ASC
LIMIT ?`, string(agent.CallbackStatusRunning), unixNano(before), limit)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find expired running callbacks: %w", err)
	}
	defer rows.Close()
	return scanJobRows(rows, "find expired running callbacks")
}

func (r *JobRepo) HasRunningTargetJob(ctx context.Context, originatorRunID, targetAgentID, excludeJobID string) (bool, error) {
	query := `SELECT count(*) FROM jobs WHERE originator_run_id = ? AND target_agent_id = ? AND status = ?`
	args := []any{originatorRunID, targetAgentID, string(agent.JobStatusRunning)}
	if excludeJobID != "" {
		query += ` AND job_id != ?`
		args = append(args, excludeJobID)
	}
	var count int64
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return false, fmt.Errorf("job_repo: has running target job: %w", err)
	}
	return count > 0, nil
}

func (r *JobRepo) HasRunningCallback(ctx context.Context, parentThreadID, excludeJobID string) (bool, error) {
	query := `SELECT count(*) FROM jobs WHERE parent_thread_id = ? AND callback_status = ?`
	args := []any{parentThreadID, string(agent.CallbackStatusRunning)}
	if excludeJobID != "" {
		query += ` AND job_id != ?`
		args = append(args, excludeJobID)
	}
	var count int64
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return false, fmt.Errorf("job_repo: has running callback: %w", err)
	}
	return count > 0, nil
}

// AcquireLock: the "same job" fast path also requires the SAME owner already
// holding the lock — otherwise a second coordinator could silently steal an
// unexpired lease just by knowing the job id. Genuine expiry is the only
// other way in. SQLite's ON CONFLICT ... WHERE expresses this directly: if
// the WHERE clause doesn't match an existing row, the update is skipped and
// RowsAffected is 0 — no separate duplicate-key fallback needed.
func (r *JobRepo) AcquireLock(ctx context.Context, lockType, lockKey, activeJobID, activeRunID, owner string, ttl time.Duration) (bool, error) {
	now := time.Now()
	expires := unixNano(now.Add(ttl))
	nowNano := unixNano(now)
	res, err := r.db.ExecContext(ctx, `
INSERT INTO job_locks(lock_key, lock_type, active_job_id, active_run_id, lease_owner, lease_expires_at, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(lock_key) DO UPDATE SET
    lock_type = excluded.lock_type,
    active_job_id = excluded.active_job_id,
    active_run_id = excluded.active_run_id,
    lease_owner = excluded.lease_owner,
    lease_expires_at = excluded.lease_expires_at,
    updated_at = excluded.updated_at
WHERE job_locks.lease_expires_at <= ? OR (job_locks.active_job_id = ? AND job_locks.lease_owner = ?)`,
		lockKey, lockType, activeJobID, activeRunID, owner, expires, nowNano, nowNano,
		nowNano, activeJobID, owner)
	if err != nil {
		return false, fmt.Errorf("job_repo: acquire lock: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("job_repo: acquire lock result: %w", err)
	}
	return rows > 0, nil
}

func (r *JobRepo) ReleaseLock(ctx context.Context, lockKey, activeJobID, owner string) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM job_locks WHERE lock_key = ? AND active_job_id = ? AND lease_owner = ?`,
		lockKey, activeJobID, owner); err != nil {
		return fmt.Errorf("job_repo: release lock: %w", err)
	}
	return nil
}

func (r *JobRepo) ClaimJobStarting(ctx context.Context, jobID, owner string, lease time.Duration) (agent.JobRecord, bool, error) {
	now := time.Now()
	rec, err := scanJob(r.db.QueryRowContext(ctx, `
UPDATE jobs SET status = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE job_id = ? AND (status = ? OR (status = ? AND lease_expires_at <= ?))
RETURNING `+jobColumns,
		string(agent.JobStatusStarting), owner, unixNano(now.Add(lease)), unixNano(now),
		jobID, string(agent.JobStatusQueued), string(agent.JobStatusStarting), unixNano(now)))
	if err == sql.ErrNoRows {
		return agent.JobRecord{}, false, nil
	}
	if err != nil {
		return agent.JobRecord{}, false, fmt.Errorf("job_repo: claim starting: %w", err)
	}
	return rec, true, nil
}

// MarkJobDispatched requires the claim owner: without it, a claimant whose
// lease already expired and got reclaimed by someone else could still
// clobber the reclaimer's dispatch with its own stale child run. Reports
// whether the CAS actually applied — a nil error alone does not mean it did
// (zero affected rows is not an error), so the caller must check applied
// before publishing the dispatch.
func (r *JobRepo) MarkJobDispatched(ctx context.Context, jobID, owner, childRunID, childThreadID string) (bool, error) {
	now := unixNano(time.Now())
	res, err := r.db.ExecContext(ctx, `
UPDATE jobs SET child_run_id = ?, child_thread_id = ?, status = ?, started_at = ?, updated_at = ?
WHERE job_id = ? AND status = ? AND lease_owner = ?`,
		childRunID, childThreadID, string(agent.JobStatusRunning), now, now,
		jobID, string(agent.JobStatusStarting), owner)
	if err != nil {
		return false, fmt.Errorf("job_repo: mark dispatched: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("job_repo: mark dispatched result: %w", err)
	}
	return rows == 1, nil
}

// MarkClaimedJobFailed terminates a job that was claimed (status=starting)
// but never reached MarkJobDispatched — child_run_id is not yet persisted at
// this point, so markJobTerminal's child-run fencing can never match it.
// Fences on the claim owner instead, the same predicate MarkJobDispatched
// itself uses, and releases the target lock the coordinator is still
// holding.
func (r *JobRepo) MarkClaimedJobFailed(ctx context.Context, jobID, owner, errText string) (bool, error) {
	now := unixNano(time.Now())
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("job_repo: begin mark claimed job failed: %w", err)
	}
	defer tx.Rollback()
	var originatorRunID, targetAgentID string
	err = tx.QueryRowContext(ctx, `SELECT originator_run_id, target_agent_id FROM jobs WHERE job_id = ? AND status = ? AND lease_owner = ?`,
		jobID, string(agent.JobStatusStarting), owner).Scan(&originatorRunID, &targetAgentID)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("job_repo: mark claimed job failed lookup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ?, lease_owner = '', lease_expires_at = NULL
WHERE job_id = ? AND status = ? AND lease_owner = ?`,
		string(agent.JobStatusFailed), errText, now, now, jobID, string(agent.JobStatusStarting), owner); err != nil {
		return false, fmt.Errorf("job_repo: mark claimed job failed: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM job_locks WHERE lock_key = ? AND active_job_id = ? AND lease_owner = ?`,
		targetLockKey(originatorRunID, targetAgentID), jobID, owner); err != nil {
		return false, fmt.Errorf("job_repo: release target lock: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("job_repo: commit mark claimed job failed: %w", err)
	}
	return true, nil
}

// RefreshJobLease fences on childRunID: once it no longer matches the job's
// current child_run_id, the heartbeat stops silently extending both the
// job's lease and the target lock's lease on behalf of a stale caller.
func (r *JobRepo) RefreshJobLease(ctx context.Context, jobID, childRunID, originatorRunID, targetAgentID, owner string, ttl time.Duration) error {
	now := time.Now()
	expires := now.Add(ttl)
	if ttl <= 0 {
		expires = now
	}
	res, err := r.db.ExecContext(ctx, `
UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE job_id = ? AND child_run_id = ? AND status IN (?, ?)`,
		owner, unixNano(expires), unixNano(now), jobID, childRunID,
		string(agent.JobStatusStarting), string(agent.JobStatusRunning))
	if err != nil {
		return fmt.Errorf("job_repo: refresh job lease: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("job_repo: refresh job lease result: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("job_repo: refresh job lease: job %s is no longer owned by run %s", jobID, childRunID)
	}
	if _, err := r.db.ExecContext(ctx, `
UPDATE job_locks SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE lock_key = ? AND active_job_id = ?`,
		owner, unixNano(expires), unixNano(now), targetLockKey(originatorRunID, targetAgentID), jobID); err != nil {
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

// markJobTerminal fences on childRunID so a mismatched/stale caller can't
// clobber the job's real outcome. It runs as one transaction: read the
// lease owner BEFORE clearing it, apply the fenced write, then release the
// target lock using the owner captured pre-update — all atomically, so a
// concurrent statement can never observe the write applied but the lock
// still held (or vice versa). Reports whether the fenced write applied — the
// caller must not notify anyone of a terminal state that never actually
// took effect.
func (r *JobRepo) markJobTerminal(ctx context.Context, jobID, childRunID, status, output, errText string) (bool, error) {
	now := unixNano(time.Now())
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("job_repo: begin mark job terminal: %w", err)
	}
	defer tx.Rollback()
	var leaseOwner, originatorRunID, targetAgentID string
	err = tx.QueryRowContext(ctx, `
SELECT lease_owner, originator_run_id, target_agent_id FROM jobs
WHERE job_id = ? AND child_run_id = ? AND status IN (?, ?, ?)`,
		jobID, childRunID, string(agent.JobStatusQueued), string(agent.JobStatusStarting), string(agent.JobStatusRunning),
	).Scan(&leaseOwner, &originatorRunID, &targetAgentID)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("job_repo: mark job terminal lookup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE jobs SET status = ?, output = ?, error = ?, finished_at = ?, updated_at = ?, lease_owner = '', lease_expires_at = NULL
WHERE job_id = ? AND child_run_id = ?`,
		status, output, errText, now, now, jobID, childRunID); err != nil {
		return false, fmt.Errorf("job_repo: mark job terminal: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM job_locks WHERE lock_key = ? AND active_job_id = ? AND lease_owner = ?`,
		targetLockKey(originatorRunID, targetAgentID), jobID, leaseOwner); err != nil {
		return false, fmt.Errorf("job_repo: release target lock: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("job_repo: commit mark job terminal: %w", err)
	}
	return true, nil
}

// FindReadyWaitingRunIDs: a run is ready iff every one of its awaiting,
// undelivered jobs is terminal. The full matching set is scanned before
// grouping — truncating the raw result set first can split a run's
// awaiting-job set across the truncation boundary and falsely report it
// ready before every job is actually seen. limit applies only to the final
// ready-run-id list, which is sorted for determinism.
func (r *JobRepo) FindReadyWaitingRunIDs(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := r.db.QueryContext(ctx, `
SELECT awaiting_parent_run_id, status FROM jobs
WHERE awaiting_parent_run_id != '' AND delivered_at IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find awaiting jobs: %w", err)
	}
	defer rows.Close()
	ready := map[string]bool{}
	for rows.Next() {
		var runID, status string
		if err := rows.Scan(&runID, &status); err != nil {
			return nil, fmt.Errorf("job_repo: decode awaiting job: %w", err)
		}
		if _, seen := ready[runID]; !seen {
			ready[runID] = true
		}
		if !isJobTerminal(status) {
			ready[runID] = false
		}
	}
	if err := rows.Err(); err != nil {
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
	rows, err := r.db.QueryContext(ctx, `
SELECT `+jobColumns+` FROM jobs
WHERE mode = ? AND status IN (?, ?, ?) AND callback_status = ?
ORDER BY finished_at ASC, job_id ASC
LIMIT ?`, agent.JobModeBackground, string(agent.JobStatusSucceeded), string(agent.JobStatusFailed), string(agent.JobStatusCancelled),
		string(agent.CallbackStatusQueued), limit)
	if err != nil {
		return nil, fmt.Errorf("job_repo: find queued callbacks: %w", err)
	}
	defer rows.Close()
	return scanJobRows(rows, "find queued callbacks")
}

// MarkCallbackRunning reports whether it actually claimed the callback: the
// caller must release its lock and skip creating the callback run on false,
// rather than assuming success.
func (r *JobRepo) MarkCallbackRunning(ctx context.Context, jobID, callbackRunID, owner string, lease time.Duration) (bool, error) {
	now := time.Now()
	res, err := r.db.ExecContext(ctx, `
UPDATE jobs SET callback_status = ?, callback_run_id = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE job_id = ? AND callback_status = ?`,
		string(agent.CallbackStatusRunning), callbackRunID, owner, unixNano(now.Add(lease)), unixNano(now),
		jobID, string(agent.CallbackStatusQueued))
	if err != nil {
		return false, fmt.Errorf("job_repo: mark callback running: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("job_repo: mark callback running result: %w", err)
	}
	return rows == 1, nil
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
	res, err := r.db.ExecContext(ctx, `
UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE job_id = ? AND callback_run_id = ? AND callback_status = ?`,
		owner, unixNano(expires), unixNano(now), jobID, callbackRunID, string(agent.CallbackStatusRunning))
	if err != nil {
		return fmt.Errorf("job_repo: refresh callback lease: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("job_repo: refresh callback lease result: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("job_repo: refresh callback lease: job %s callback is no longer owned by run %s", jobID, callbackRunID)
	}
	if _, err := r.db.ExecContext(ctx, `
UPDATE job_locks SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE lock_key = ? AND active_job_id = ?`,
		owner, unixNano(expires), unixNano(now), callbackLockKey(parentThreadID), jobID); err != nil {
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
// outcome. Like markJobTerminal, it fences on callbackRunID and releases the
// callback lock atomically in the same transaction, gated on the fenced
// write actually having applied — a mismatched call must never release a
// lock a different, currently-legitimate callback attempt still holds.
func (r *JobRepo) markCallbackTerminal(ctx context.Context, jobID, callbackRunID, status, errText string) error {
	now := unixNano(time.Now())
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("job_repo: begin mark callback terminal: %w", err)
	}
	defer tx.Rollback()
	var parentThreadID, leaseOwner string
	err = tx.QueryRowContext(ctx, `SELECT parent_thread_id, lease_owner FROM jobs WHERE job_id = ? AND callback_run_id = ? AND callback_status = ?`,
		jobID, callbackRunID, callbackFenceStatus(callbackRunID)).Scan(&parentThreadID, &leaseOwner)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("job_repo: mark callback terminal lookup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE jobs SET callback_status = ?, callback_error = ?, updated_at = ?
WHERE job_id = ? AND callback_run_id = ?`,
		status, errText, now, jobID, callbackRunID); err != nil {
		return fmt.Errorf("job_repo: mark callback terminal: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM job_locks WHERE lock_key = ? AND active_job_id = ? AND lease_owner = ?`,
		callbackLockKey(parentThreadID), jobID, leaseOwner); err != nil {
		return fmt.Errorf("job_repo: release callback lock: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("job_repo: commit mark callback terminal: %w", err)
	}
	return nil
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
