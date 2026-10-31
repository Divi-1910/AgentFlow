package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"backend/agent"
	"backend/model"
	"backend/pagination"
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
	Cancelled   int64
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
	cancelled, err := tx.ExecContext(ctx, `
UPDATE runs
SET status = ?, active_slot = NULL, last_error = ?, updated_at = ?
WHERE user_id = ? AND status = ?`, string(model.RunStatusCancelled), "cancelled during runtime restart", now, userID, string(model.RunStatusCancelling))
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: recover cancelling runs: %w", err)
	}
	interrupted, err := tx.ExecContext(ctx, `
UPDATE runs
SET status = ?, updated_at = ?
WHERE user_id = ? AND status = ?
  AND (dispatch_started = 1 OR submission_key = '')
  AND EXISTS (SELECT 1 FROM run_checkpoints c WHERE c.run_id = runs.run_id)`,
		string(model.RunStatusInterrupted), now, userID, string(model.RunStatusRunning))
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: recover checkpointed runs: %w", err)
	}
	failed, err := tx.ExecContext(ctx, `
UPDATE runs
SET status = ?, active_slot = NULL, last_error = ?, updated_at = ?
WHERE user_id = ? AND status = ?
  AND (dispatch_started = 1 OR submission_key = '')
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
	cancelledCount, err := cancelled.RowsAffected()
	if err != nil {
		return RecoveryResult{}, fmt.Errorf("run_repo: cancelling recovery result: %w", err)
	}
	return RecoveryResult{Interrupted: interruptedCount, Failed: failedCount, Cancelled: cancelledCount}, nil
}

func (r *RunRepo) AdmitTopLevelRun(ctx context.Context, in agent.RunAdmission) (agent.RunAdmissionResult, error) {
	now := unixNano(time.Now())
	_, err := r.db.ExecContext(ctx, `
INSERT INTO runs(run_id, thread_id, agent_id, user_id, status, attempt, steps_completed,
                 originator_run_id, parent_run_id, invocation_kind, job_id,
                 submission_key, accepted_input, prompt_persisted, active_slot, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, 1, 0, ?, '', ?, '', ?, ?, 0, ?, ?, ?)`,
		in.RunID, in.ThreadID, in.AgentID, in.UserID, string(model.RunStatusRunning), in.RunID,
		agent.InvocationTopLevel, in.SubmissionKey, in.AcceptedInput, activeSlot(in.UserID, in.ThreadID), now, now)
	if err == nil {
		info, getErr := r.GetRun(ctx, in.RunID)
		return agent.RunAdmissionResult{Run: info, Created: true}, getErr
	}

	existing, findErr := r.getRunBySubmission(ctx, in.UserID, in.ThreadID, in.SubmissionKey)
	if findErr == nil {
		if existing.AcceptedInput != in.AcceptedInput || existing.AgentID != in.AgentID {
			return agent.RunAdmissionResult{Run: existing}, agent.ErrSubmissionKeyConflict
		}
		return agent.RunAdmissionResult{Run: existing, Replayed: true}, nil
	}
	if findErr != sql.ErrNoRows {
		return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: inspect duplicate submission: %w", findErr)
	}
	active, activeErr := r.getRunByActiveSlot(ctx, activeSlot(in.UserID, in.ThreadID))
	if activeErr == nil {
		return agent.RunAdmissionResult{Run: active, ActiveRun: active.RunID}, agent.ErrThreadRunActive
	}
	if activeErr != sql.ErrNoRows {
		return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: inspect active run: %w", activeErr)
	}
	return agent.RunAdmissionResult{}, fmt.Errorf("run_repo: admit run: %w", err)
}

func activeSlot(userID, threadID string) string { return userID + ":" + threadID }

func (r *RunRepo) MarkPromptPersisted(ctx context.Context, runID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE runs SET prompt_persisted = 1, updated_at = ? WHERE run_id = ?`, unixNano(time.Now()), runID)
	if err != nil {
		return fmt.Errorf("run_repo: mark prompt persisted: %w", err)
	}
	return nil
}

func (r *RunRepo) ClaimRunDispatch(ctx context.Context, runID string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE runs SET dispatch_started = 1, updated_at = ? WHERE run_id = ? AND status = ? AND dispatch_started = 0`,
		unixNano(time.Now()), runID, string(model.RunStatusRunning))
	if err != nil {
		return false, fmt.Errorf("run_repo: claim dispatch: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("run_repo: claim dispatch result: %w", err)
	}
	return n > 0, nil
}

func (r *RunRepo) ListPendingAcceptedPrompts(ctx context.Context, userID string) ([]*agent.RunInfo, error) {
	query := `SELECT ` + runColumns + ` FROM runs WHERE accepted_input <> '' AND prompt_persisted = 0`
	args := []any{}
	if userID != "" {
		query += ` AND user_id = ?`
		args = append(args, userID)
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("run_repo: list pending prompts: %w", err)
	}
	defer rows.Close()
	var infos []*agent.RunInfo
	for rows.Next() {
		info, err := scanRun(rows)
		if err != nil {
			return nil, fmt.Errorf("run_repo: decode pending prompt: %w", err)
		}
		infos = append(infos, info)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("run_repo: iterate pending prompts: %w", err)
	}
	return infos, nil
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
	active := "active_slot"
	if isTerminalRunStatus(to) {
		active = "NULL"
	}
	res, err := r.db.ExecContext(ctx, `UPDATE runs SET status = ?, active_slot = `+active+`, updated_at = ? WHERE run_id = ? AND status = ?`, to, unixNano(time.Now()), runID, from)
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
	active := "active_slot"
	if isTerminalRunStatus(to) {
		active = "NULL"
	}
	res, err := r.db.ExecContext(ctx, `
UPDATE runs SET status = ?, active_slot = `+active+`, updated_at = ?
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
	terminal := isTerminalRunStatus(status)
	activeExpression := "active_slot"
	if terminal {
		activeExpression = "NULL"
	}
	guard := ` AND (status NOT IN ('cancelling', 'cancelled', 'completed', 'failed') OR status = ?)`
	var result sql.Result
	if lastError == "" {
		args := []any{status, unixNano(now), runID}
		args = append(args, status)
		result, err = tx.ExecContext(ctx, `UPDATE runs SET status = ?, active_slot = `+activeExpression+`, updated_at = ? WHERE run_id = ?`+guard, args...)
	} else {
		args := []any{status, lastError, unixNano(now), runID}
		args = append(args, status)
		result, err = tx.ExecContext(ctx, `UPDATE runs SET status = ?, active_slot = `+activeExpression+`, last_error = ?, updated_at = ? WHERE run_id = ?`+guard, args...)
	}
	if err != nil {
		return fmt.Errorf("run_repo: update status: %w", err)
	}
	matched, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("run_repo: update status result: %w", err)
	}
	if matched == 0 {
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("run_repo: commit fenced status update: %w", err)
		}
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
		if _, err := tx.ExecContext(ctx, `UPDATE run_checkpoints SET expires_at = ? WHERE run_id = ?`, unixNano(now.Add(retention)), runID); err != nil {
			return fmt.Errorf("run_repo: set checkpoint retention: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("run_repo: commit update status: %w", err)
	}
	return nil
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
	placeholders := ""
	args := []any{string(model.RunStatusRunning), activeSlot(userID, info.ThreadID), unixNano(time.Now()), runID, userID}
	for i, status := range from {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, status)
	}
	query := `UPDATE runs SET status = ?, active_slot = ?, attempt = attempt + 1, updated_at = ?
WHERE run_id = ? AND user_id = ? AND parent_run_id = '' AND invocation_kind IN ('', 'top_level')
  AND status IN (` + placeholders + `) RETURNING attempt`
	var attempt int
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&attempt); err != nil {
		if err == sql.ErrNoRows {
			return 0, false, nil
		}
		active, activeErr := r.getRunByActiveSlot(ctx, activeSlot(userID, info.ThreadID))
		if activeErr == nil && active.RunID != runID {
			return 0, false, agent.ErrThreadRunActive
		}
		return 0, false, fmt.Errorf("run_repo: resume run: %w", err)
	}
	return attempt, true, nil
}

func (r *RunRepo) RequestCancelForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, bool, error) {
	info, err := r.GetRunForUser(ctx, runID, userID)
	if err != nil {
		return nil, false, err
	}
	res, err := r.db.ExecContext(ctx, `UPDATE runs SET status = ?, updated_at = ?
WHERE run_id = ? AND user_id = ? AND parent_run_id = '' AND invocation_kind IN ('', ?)
  AND status IN (?, ?, ?, ?)`,
		string(model.RunStatusCancelling), unixNano(time.Now()), runID, userID,
		agent.InvocationTopLevel,
		string(model.RunStatusRunning), string(model.RunStatusWaitingJobs), string(model.RunStatusResumable), string(model.RunStatusInterrupted))
	if err != nil {
		return nil, false, fmt.Errorf("run_repo: request cancel: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, false, fmt.Errorf("run_repo: request cancel result: %w", err)
	}
	return info, n > 0, nil
}

func (r *RunRepo) FinalizeCancelForUser(ctx context.Context, runID, userID string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE runs SET status = ?, active_slot = NULL, last_error = ?, updated_at = ?
WHERE run_id = ? AND user_id = ? AND parent_run_id = '' AND invocation_kind IN ('', ?)
  AND status = ?`,
		string(model.RunStatusCancelled), "cancelled by user", unixNano(time.Now()), runID, userID,
		agent.InvocationTopLevel, string(model.RunStatusCancelling))
	if err != nil {
		return false, fmt.Errorf("run_repo: finalize cancel: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("run_repo: finalize cancel result: %w", err)
	}
	if n > 0 {
		if err := r.UpdateStatus(ctx, runID, string(model.RunStatusCancelled), "cancelled by user"); err != nil {
			return false, err
		}
	}
	return n > 0, nil
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
	return r.getRun(ctx, `SELECT `+runColumns+`
FROM runs WHERE run_id = ?`, runID)
}

func (r *RunRepo) GetRunForUser(ctx context.Context, runID, userID string) (*agent.RunInfo, error) {
	return r.getRun(ctx, `SELECT `+runColumns+`
FROM runs WHERE run_id = ? AND user_id = ?`, runID, userID)
}

const runColumns = `run_id, thread_id, agent_id, user_id, status, attempt,
steps_completed, last_error, originator_run_id, parent_run_id, invocation_kind, job_id,
submission_key, accepted_input, prompt_persisted, dispatch_started, created_at, updated_at`

func (r *RunRepo) getRun(ctx context.Context, query string, args ...any) (*agent.RunInfo, error) {
	var (
		info                 agent.RunInfo
		createdAt, updatedAt int64
	)
	err := r.db.QueryRowContext(ctx, query, args...).Scan(runScanDestinations(&info, &createdAt, &updatedAt)...)
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
	info.CreatedAt = timeFromUnixNano(createdAt)
	info.UpdatedAt = timeFromUnixNano(updatedAt)
	return &info, nil
}

func runScanDestinations(info *agent.RunInfo, createdAt, updatedAt *int64) []any {
	return []any{&info.RunID, &info.ThreadID, &info.AgentID, &info.UserID, &info.Status,
		&info.Attempt, &info.StepsCompleted, &info.LastError, &info.OriginatorRunID,
		&info.ParentRunID, &info.InvocationKind, &info.JobID, &info.SubmissionKey,
		&info.AcceptedInput, &info.PromptPersisted, &info.DispatchStarted, createdAt, updatedAt}
}

func scanRun(scanner rowScanner) (*agent.RunInfo, error) {
	var info agent.RunInfo
	var createdAt, updatedAt int64
	if err := scanner.Scan(runScanDestinations(&info, &createdAt, &updatedAt)...); err != nil {
		return nil, err
	}
	info.CreatedAt = timeFromUnixNano(createdAt)
	info.UpdatedAt = timeFromUnixNano(updatedAt)
	return &info, nil
}

func (r *RunRepo) getRunBySubmission(ctx context.Context, userID, threadID, key string) (*agent.RunInfo, error) {
	return r.getRunRaw(ctx, `SELECT `+runColumns+` FROM runs WHERE user_id = ? AND thread_id = ? AND submission_key = ?`, userID, threadID, key)
}

func (r *RunRepo) getRunByActiveSlot(ctx context.Context, slot string) (*agent.RunInfo, error) {
	return r.getRunRaw(ctx, `SELECT `+runColumns+` FROM runs WHERE active_slot = ?`, slot)
}

func (r *RunRepo) getRunRaw(ctx context.Context, query string, args ...any) (*agent.RunInfo, error) {
	var info agent.RunInfo
	var createdAt, updatedAt int64
	err := r.db.QueryRowContext(ctx, query, args...).Scan(runScanDestinations(&info, &createdAt, &updatedAt)...)
	if err != nil {
		return nil, err
	}
	info.CreatedAt = timeFromUnixNano(createdAt)
	info.UpdatedAt = timeFromUnixNano(updatedAt)
	return &info, nil
}

func (r *RunRepo) ListTopLevelByThreadForUser(ctx context.Context, threadID, userID string, limit int) ([]*agent.RunInfo, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := r.db.QueryContext(ctx, `
SELECT `+runColumns+`
FROM runs
WHERE thread_id = ? AND user_id = ? AND parent_run_id = ''
  AND invocation_kind IN ('', ?)
ORDER BY created_at DESC, run_id DESC
LIMIT ?`, threadID, userID, agent.InvocationTopLevel, limit)
	if err != nil {
		return nil, fmt.Errorf("run_repo: list thread runs: %w", err)
	}
	defer rows.Close()

	var infos []*agent.RunInfo
	for rows.Next() {
		var (
			info                 agent.RunInfo
			createdAt, updatedAt int64
		)
		if err := rows.Scan(runScanDestinations(&info, &createdAt, &updatedAt)...); err != nil {
			return nil, fmt.Errorf("run_repo: decode thread runs: %w", err)
		}
		info.CreatedAt = timeFromUnixNano(createdAt)
		info.UpdatedAt = timeFromUnixNano(updatedAt)
		infos = append(infos, &info)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("run_repo: iterate thread runs: %w", err)
	}
	return infos, nil
}

func (r *RunRepo) ListTopLevelPageForUser(ctx context.Context, userID string, filter agent.RunListFilter, request pagination.Request) (pagination.Page[*agent.RunInfo], error) {
	if request.Limit <= 0 {
		request.Limit = 50
	}
	where := `user_id = ? AND parent_run_id = '' AND invocation_kind IN ('', ?)`
	args := []any{userID, agent.InvocationTopLevel}
	if filter.ThreadID != "" {
		where += ` AND thread_id = ?`
		args = append(args, filter.ThreadID)
	}
	if filter.ResourceID != "" {
		where += ` AND agent_id = ?`
		args = append(args, filter.ResourceID)
	}
	if len(filter.Statuses) > 0 {
		where += ` AND status IN (` + strings.TrimSuffix(strings.Repeat("?,", len(filter.Statuses)), ",") + `)`
		for _, status := range filter.Statuses {
			args = append(args, status)
		}
	}
	if request.Cursor != nil {
		where += ` AND (created_at < ? OR (created_at = ? AND run_id < ?))`
		at := unixNano(request.Cursor.Time)
		args = append(args, at, at, request.Cursor.ID)
	}
	args = append(args, request.Limit+1)
	rows, err := r.db.QueryContext(ctx, `SELECT `+runColumns+` FROM runs WHERE `+where+`
ORDER BY created_at DESC, run_id DESC LIMIT ?`, args...)
	if err != nil {
		return pagination.Page[*agent.RunInfo]{}, fmt.Errorf("run_repo: list owner runs: %w", err)
	}
	defer rows.Close()
	var items []*agent.RunInfo
	for rows.Next() {
		var info agent.RunInfo
		var createdAt, updatedAt int64
		if err := rows.Scan(runScanDestinations(&info, &createdAt, &updatedAt)...); err != nil {
			return pagination.Page[*agent.RunInfo]{}, fmt.Errorf("run_repo: decode owner runs: %w", err)
		}
		info.CreatedAt = timeFromUnixNano(createdAt)
		info.UpdatedAt = timeFromUnixNano(updatedAt)
		items = append(items, &info)
	}
	if err := rows.Err(); err != nil {
		return pagination.Page[*agent.RunInfo]{}, fmt.Errorf("run_repo: iterate owner runs: %w", err)
	}
	hasMore := len(items) > request.Limit
	if hasMore {
		items = items[:request.Limit]
	}
	page := pagination.Page[*agent.RunInfo]{Items: items, HasMore: hasMore}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		page.Next = &pagination.Cursor{Kind: "runs", Time: last.CreatedAt, ID: last.RunID}
	}
	return page, nil
}
