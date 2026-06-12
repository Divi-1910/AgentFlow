package dispatcher

import (
	"context"

	"backend/agent"
)

type taskBudgetStore interface {
	EnsureTask(ctx context.Context, originatorRunID, userID string, maxRuns int) error
	BudgetStatus(ctx context.Context, originatorRunID string) (agent.RunBudgetStatus, error)
	TryConsumeRun(ctx context.Context, originatorRunID, userID, budgetKey string) (agent.RunBudgetStatus, bool, error)
}
