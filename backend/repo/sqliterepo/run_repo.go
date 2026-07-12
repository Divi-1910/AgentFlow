package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"backend/agent"
	"backend/model"
)

const (
	retentionCompleted = 7 * 24 * time.Hour
	retentionFailed    = 30 * 24 * time.Hour
)

type RunRepo struct{ db *sql.DB }

func NewRunRepo(db *sql.DB) *RunRepo { return &RunRepo{db: db} }

type RecoveryResult struct {
	Interrupted int64
	Failed      int64
}

// RecoverOrphanedRuns is called once during cold start, before workers begin.
// With no prior process still executing, every owned running row is orphaned:
// checkpointed runs remain resumable, while checkpointless runs cannot resume.
func (r *RunRepo) RecoverOrphanedRuns(ctx context.Context, userID string) (RecoveryResult, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: begin orphan recovery: %w", err)
	}
	defer tx.Rollback()
	now := unixNano(time.Now())
	interrupted, err := tx.ExecContext(ctx, `
UPDATE runs
SET status = ?, updated_at = ?
WHERE user_id = ? AND status = ?
  AND EXISTS (SELECT 1 FROM run_checkpoints c WHERE c.run_id = runs.run_id)`,
		string(model.RunStatusInterrupted), now, userID, string(model.RunStatusRunning))
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: recover checkpointed runs: %w", err)
	}
	failed, err := tx.ExecContext(ctx, `
UPDATE runs
SET status = ?, last_error = ?, updated_at = ?
WHERE user_id = ? AND status = ?
  AND NOT EXISTS (SELECT 1 FROM run_checkpoints c WHERE c.run_id = runs.run_id)`,
		string(model.RunStatusFailed), "runtime restarted before first checkpoint", now, userID, string(model.RunStatusRunning))
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: recover checkpointless runs: %w", err)
	}
	interruptedCount, err := interrupted.RowsAffected()
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: checkpointed recovery result: %w", err)
	}
	failedCount, err := failed.RowsAffected()
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: checkpointless recovery result: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: commit orphan recovery: %w", err)
	}
	return RecoveryResult{Interrupted: interruptedCount, Failed: failedCount}, nil
}

func (r *RunRepo) CreateRun(ctx context.Context, runID, threadID, agentID, userID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, runID, "", agent.InvocationTopLevel, "")
}

func (r *RunRepo) CreateChildRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, agent.InvocationSyncDelegate, "")
}

func (r *RunRepo) CreateChildRunWithKind(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	return r.createRun(ctx, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID)
}

func (r *RunRepo) createRun(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	now := unixNano(time.Now())
	_, err := r.db.ExecContext(ctx, `
INSERT INTO runs(run_id, thread_id, agent_id, user_id, status, attempt, steps_completed,
                 originator_run_id, parent_run_id, invocation_kind, job_id, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
		runID, threadID, agentID, userID, string(model.RunStatusRunning), originatorRunID,
		parentRunID, invocationKind, jobID, now, now)
	if err != nil {
		return fmt.Errorf("run_repo: create run: %w", err)
	}
	return nil
}

// Save commits the append-only checkpoint and the run's projected step in one
// transaction, so reopening never observes a checkpoint without its run state.
func (r *RunRepo) Save(ctx context.Context, snapshot agent.RunSnapshot) error {
	gz, err := agent.CompressSnapshot(snapshot)
	if err != nil {
		return fmt.Errorf("run_repo: compress snapshot: %w", err)
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("run_repo: begin save checkpoint: %w", err)
	}
	defer tx.Rollback()
	now := unixNano(time.Now())
	if _, err := tx.ExecContext(ctx, `
INSERT INTO run_checkpoints(run_id, step, phase, snapshot_gz, created_at)
VALUES(?, ?, ?, ?, ?)`, snapshot.RunID, snapshot.State.StepsCompleted, snapshot.Meta.Phase, gz, now); err != nil {
		return fmt.Errorf("run_repo: save checkpoint: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET steps_completed = ?, updated_at = ? WHERE run_id = ?`,
		snapshot.State.StepsCompleted, now, snapshot.RunID); err != nil {
		return fmt.Errorf("run_repo: update checkpoint projection: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("run_repo: commit checkpoint: %w", err)
	}
	return nil
}

func (r *RunRepo) LoadLatest(ctx context.Context, runID string) (*agent.RunSnapshot, error) {
	var gz []byte
	err := r.db.QueryRowContext(ctx, `
SELECT snapshot_gz FROM run_checkpoints
WHERE run_id = ?
ORDER BY step DESC, created_at DESC, id DESC
LIMIT 1`, runID).Scan(&gz)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("run_repo: no checkpoint found for run %s", runID)
	}
	if err != nil {
		return nil, fmt.Errorf("run_repo: load checkpoint: %w", err)
	}
	snapshot, err := agent.DecompressSnapshot(gz)
	if err != nil {
		return nil, fmt.Errorf("run_repo: decompress checkpoint: %w", err)
	}
	return snapshot, nil
}

func (r *RunRepo) TransitionStatus(ctx context.Context, runID, from, to string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ? AND status = ?`,
		to, unixNano(time.Now()), runID, from)
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status result: %w", err)
	}
	return n > 0, nil
}

func (r *RunRepo) TransitionStatusForUser(ctx context.Context, runID, userID, from, to string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `
UPDATE runs SET status = ?, updated_at = ?
WHERE run_id = ? AND user_id = ? AND status = ?`, to, unixNano(time.Now()), runID, userID, from)
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status for user: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("run_repo: transition status for user result: %w", err)
	}
	return n > 0, nil
}

// UpdateStatus changes the run and applies checkpoint retention atomically.
// Empty lastError preserves the previously recorded error, matching Mongo.
func (r *RunRepo) UpdateStatus(ctx context.Context, runID, status, lastError string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("run_repo: begin update status: %w", err)
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	if lastError == "" {
		_, err = tx.ExecContext(ctx, `UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?`, status, unixNano(now), runID)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE runs SET status = ?, last_error = ?, updated_at = ? WHERE run_id = ?`, status, lastError, unixNano(now), runID)
	}
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
		if _, err := tx.ExecContext(ctx, `UPDATE run_checkpoints SET expires_at = ? WHERE run_id = ?`, unixNano(now.Add(retention)), runID); err != nil {
			return fmt.Errorf("run_repo: set checkpoint retention: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("run_repo: commit update status: %w", err)
	}
	return nil
}

func (r *RunRepo) IncrementAttempt(ctx context.Context, runID string) (int, error) {
	var attempt int
	err := r.db.QueryRowContext(ctx, `
UPDATE runs SET attempt = attempt + 1, updated_at = ? WHERE run_id = ?
RETURNING attempt`, unixNano(time.Now()), runID).Scan(&attempt)
	if err != nil {
		return 0, fmt.Errorf("run_repo: increment attempt: %w", err)
	}
	return attempt, nil
}

func (r *RunRepo) GetRun(ctx context.Context, runID string) (*agent.RunInfo, error) {
	return r.getRun(ctx, `SELECT run_id, thread_id, agent_id, user_id, status, attempt,
steps_completed, last_error, originator_run_id, parent_run_id, invocation_kind, job_id
FROM runs WHERE run_id = ?`, runID)
}

func (r *RunRepo) GetRunForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, error) {
	return r.getRun(ctx, `SELECT run_id, thread_id, agent_id, user_id, status, attempt,
steps_completed, last_error, originator_run_id, parent_run_id, invocation_kind, job_id
FROM runs WHERE run_id = ? AND user_id = ?`, runID, userID)
}

func (r *RunRepo) getRun(ctx context.Context, query string, args ...any) (*agent.RunInfo, error) {
	var info agent.RunInfo
	err := r.db.QueryRowContext(ctx, query, args...).Scan(
		&info.RunID, &info.ThreadID, &info.AgentID, &info.UserID, &info.Status,
		&info.Attempt, &info.StepsCompleted, &info.LastError, &info.OriginatorRunID,
		&info.ParentRunID, &info.InvocationKind, &info.JobID,
	)
	if err == sql.ErrNoRows {
		runID := ""
		if len(args) > 0 {
			runID, _ = args[0].(string)
		}
		return nil, fmt.Errorf("run_repo: run not found: %s", runID)
	}
	if err != nil {
		return nil, fmt.Errorf("run_repo: get run: %w", err)
	}
	return &info, nil
}
