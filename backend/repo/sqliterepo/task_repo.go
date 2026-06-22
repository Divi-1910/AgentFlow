package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"backend/agent"
)

type TaskRepo struct{ db *sql.DB }

func NewTaskRepo(db *sql.DB) *TaskRepo { return &TaskRepo{db: db} }

func (r *TaskRepo) EnsureTask(ctx context.Context, originatorRunID, userID string, maxRuns int) error {
	if originatorRunID == "" {
		return nil
	}
	maxRuns = normalizeMaxRuns(maxRuns)
	now := unixNano(time.Now())
	_, err := r.db.ExecContext(ctx, `
INSERT INTO tasks(originator_run_id, user_id, max_runs, runs_used, created_at, updated_at)
VALUES(?, ?, ?, 0, ?, ?)
ON CONFLICT(originator_run_id) DO UPDATE SET updated_at = excluded.updated_at`,
		originatorRunID, userID, maxRuns, now, now)
	if err != nil {
		return fmt.Errorf("task_repo: ensure task: %w", err)
	}
	return nil
}

func (r *TaskRepo) BudgetStatus(ctx context.Context, originatorRunID string) (agent.RunBudgetStatus, error) {
	if originatorRunID == "" {
		return budgetStatus(originatorRunID, agent.DefaultMaxTaskRuns, 0), nil
	}
	var maxRuns, runsUsed int
	err := r.db.QueryRowContext(ctx, `SELECT max_runs, runs_used FROM tasks WHERE originator_run_id = ?`, originatorRunID).Scan(&maxRuns, &runsUsed)
	if err == sql.ErrNoRows {
		return budgetStatus(originatorRunID, agent.DefaultMaxTaskRuns, 0), nil
	}
	if err != nil {
		return agent.RunBudgetStatus{}, fmt.Errorf("task_repo: budget status: %w", err)
	}
	return budgetStatus(originatorRunID, maxRuns, runsUsed), nil
}

// TryConsumeRun holds an IMMEDIATE transaction across replay detection, cap
// inspection, key admission, and increment. A rejected key is never inserted;
// an admitted key remains a successful replay even after the cap is exhausted.
func (r *TaskRepo) TryConsumeRun(ctx context.Context, originatorRunID, userID, budgetKey string) (agent.RunBudgetStatus, bool, error) {
	if originatorRunID == "" {
		return budgetStatus(originatorRunID, agent.DefaultMaxTaskRuns, 0), true, nil
	}
	if budgetKey == "" {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: budget key is required")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: begin consume run budget: %w", err)
	}
	defer tx.Rollback()

	var maxRuns, runsUsed int
	err = tx.QueryRowContext(ctx, `SELECT max_runs, runs_used FROM tasks WHERE originator_run_id = ?`, originatorRunID).Scan(&maxRuns, &runsUsed)
	if err == sql.ErrNoRows {
		now := unixNano(time.Now())
		maxRuns = agent.DefaultMaxTaskRuns
		if _, err = tx.ExecContext(ctx, `
INSERT INTO tasks(originator_run_id, user_id, max_runs, runs_used, created_at, updated_at)
VALUES(?, ?, ?, 0, ?, ?)`, originatorRunID, userID, maxRuns, now, now); err != nil {
			return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: create absent task: %w", err)
		}
		runsUsed = 0
	} else if err != nil {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: read task: %w", err)
	}

	var admitted int
	err = tx.QueryRowContext(ctx, `
SELECT EXISTS(SELECT 1 FROM task_run_keys WHERE originator_run_id = ? AND budget_key = ?)`,
		originatorRunID, budgetKey).Scan(&admitted)
	if err != nil {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: check budget key: %w", err)
	}
	if admitted == 1 {
		if err := tx.Commit(); err != nil {
			return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: commit budget replay: %w", err)
		}
		return budgetStatus(originatorRunID, maxRuns, runsUsed), true, nil
	}

	if runsUsed >= normalizeMaxRuns(maxRuns) {
		if err := tx.Commit(); err != nil {
			return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: commit budget rejection: %w", err)
		}
		return budgetStatus(originatorRunID, maxRuns, runsUsed), false, nil
	}

	now := unixNano(time.Now())
	if _, err := tx.ExecContext(ctx, `INSERT INTO task_run_keys(originator_run_id, budget_key, created_at) VALUES(?, ?, ?)`, originatorRunID, budgetKey, now); err != nil {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: admit budget key: %w", err)
	}
	if err := tx.QueryRowContext(ctx, `
UPDATE tasks SET runs_used = runs_used + 1, updated_at = ? WHERE originator_run_id = ?
RETURNING max_runs, runs_used`, now, originatorRunID).Scan(&maxRuns, &runsUsed); err != nil {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: consume run budget: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return agent.RunBudgetStatus{}, false, fmt.Errorf("task_repo: commit run budget: %w", err)
	}
	return budgetStatus(originatorRunID, maxRuns, runsUsed), true, nil
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
