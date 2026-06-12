package agent

import "fmt"

const DefaultMaxTaskRuns = 50

type RunBudgetStatus struct {
	OriginatorRunID string
	MaxRuns         int
	RunsUsed        int
	Exhausted       bool
}

type RunBudgetError struct {
	MaxRuns  int
	RunsUsed int
}

func (e RunBudgetError) Error() string {
	return fmt.Sprintf("run budget exhausted: used %d of %d runs", e.RunsUsed, e.MaxRuns)
}

func RunBudgetErrorFromStatus(status RunBudgetStatus) RunBudgetError {
	maxRuns := status.MaxRuns
	if maxRuns <= 0 {
		maxRuns = DefaultMaxTaskRuns
	}
	return RunBudgetError{MaxRuns: maxRuns, RunsUsed: status.RunsUsed}
}
