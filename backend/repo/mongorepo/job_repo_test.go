package mongorepo_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/model"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func newJobRepo(t *testing.T) (*mongorepo.JobRepo, *mongo.Collection, *mongo.Collection) {
	t.Helper()
	jobs := col(t, "jobs")
	locks := col(t, "job_locks")
	r := mongorepo.NewJobRepo(jobs, locks)
	if err := r.EnsureIndexes(context.Background()); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}
	return r, jobs, locks
}

func dispatchRequiredJob(t *testing.T, r *mongorepo.JobRepo) agent.DispatchAgentResult {
	t.Helper()
	return dispatchRequiredJobWithToolCall(t, r, "dispatch-1")
}

func dispatchRequiredJobWithToolCall(t *testing.T, r *mongorepo.JobRepo, toolCallID string) agent.DispatchAgentResult {
	t.Helper()
	res, err := r.DispatchAgent(context.Background(), agent.DispatchAgentRequest{
		ParentRunID:     "parent-run",
		OriginatorRunID: "originator-run",
		ParentThreadID:  "parent-thread",
		ParentAgentID:   "agent-a",
		UserID:          "user-1",
		ToolCallID:      toolCallID,
		DelegateTool:    "ask_researcher",
		TargetAgentID:   "agent-b",
		Task:            "research",
		Mode:            agent.JobModeRequired,
		DelegationChain: []string{"agent-a"},
		DelegationDepth: 0,
	})
	if err != nil {
		t.Fatalf("DispatchAgent: %v", err)
	}
	return res
}

func TestJobRepoDispatchAgentIsIdempotentByParentRunAndToolCall(t *testing.T) {
	r, _, _ := newJobRepo(t)
	ctx := context.Background()

	first := dispatchRequiredJobWithToolCall(t, r, "dispatch-idempotent")
	second, err := r.DispatchAgent(ctx, agent.DispatchAgentRequest{
		ParentRunID:     "parent-run",
		OriginatorRunID: "originator-run",
		ParentThreadID:  "parent-thread",
		ParentAgentID:   "agent-a",
		UserID:          "user-1",
		ToolCallID:      "dispatch-idempotent",
		DelegateTool:    "ask_researcher",
		TargetAgentID:   "agent-b",
		Task:            "different task should not overwrite",
		Mode:            agent.JobModeRequired,
	})
	if err != nil {
		t.Fatalf("second DispatchAgent: %v", err)
	}
	if first.JobID != second.JobID {
		t.Fatalf("job IDs differ: first=%s second=%s", first.JobID, second.JobID)
	}
	doc, err := r.GetJob(ctx, first.JobID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if doc.Task != "research" {
		t.Fatalf("Task = %q, want original insert value", doc.Task)
	}
}

func TestJobRepoDispatchAgentConsumesBudgetOnceForReplay(t *testing.T) {
	r, jobs, _ := newJobRepo(t)
	tasks, taskCol := newTaskRepo(t)
	r.SetTaskBudgetStore(tasks)
	ctx := context.Background()
	if err := tasks.EnsureTask(ctx, "originator-run", "user-1", 1); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}

	first := dispatchRequiredJobWithToolCall(t, r, "dispatch-budget")
	second, err := r.DispatchAgent(ctx, agent.DispatchAgentRequest{
		ParentRunID:     "parent-run",
		OriginatorRunID: "originator-run",
		ParentThreadID:  "parent-thread",
		ParentAgentID:   "agent-a",
		UserID:          "user-1",
		ToolCallID:      "dispatch-budget",
		DelegateTool:    "ask_researcher",
		TargetAgentID:   "agent-b",
		Task:            "replay",
		Mode:            agent.JobModeRequired,
	})
	if err != nil {
		t.Fatalf("replay DispatchAgent: %v", err)
	}
	if first.JobID != second.JobID {
		t.Fatalf("job IDs differ: first=%s second=%s", first.JobID, second.JobID)
	}
	task := mustTaskDoc(t, taskCol, "originator-run")
	if task.RunsUsed != 1 || len(task.RunKeys) != 1 {
		t.Fatalf("task budget = used:%d keys:%v, want 1/1", task.RunsUsed, task.RunKeys)
	}
	count, err := jobs.CountDocuments(ctx, bson.M{"originator_run_id": "originator-run"})
	if err != nil {
		t.Fatalf("CountDocuments: %v", err)
	}
	if count != 1 {
		t.Fatalf("job count = %d, want 1", count)
	}
}

func TestJobRepoDispatchAgentRejectsWhenBudgetExhausted(t *testing.T) {
	r, jobs, _ := newJobRepo(t)
	tasks, taskCol := newTaskRepo(t)
	r.SetTaskBudgetStore(tasks)
	ctx := context.Background()
	if err := tasks.EnsureTask(ctx, "originator-run", "user-1", 1); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	if _, ok, err := tasks.TryConsumeRun(ctx, "originator-run", "user-1", "used"); err != nil || !ok {
		t.Fatalf("pre-consume ok=%v err=%v", ok, err)
	}

	_, err := r.DispatchAgent(ctx, agent.DispatchAgentRequest{
		ParentRunID:     "parent-run",
		OriginatorRunID: "originator-run",
		ParentThreadID:  "parent-thread",
		ParentAgentID:   "agent-a",
		UserID:          "user-1",
		ToolCallID:      "dispatch-rejected",
		DelegateTool:    "ask_researcher",
		TargetAgentID:   "agent-b",
		Task:            "research",
		Mode:            agent.JobModeBackground,
	})
	var budgetErr agent.RunBudgetError
	if !errors.As(err, &budgetErr) {
		t.Fatalf("DispatchAgent error = %v, want RunBudgetError", err)
	}
	if budgetErr.MaxRuns != 1 || budgetErr.RunsUsed != 1 {
		t.Fatalf("budget err = %+v, want 1/1", budgetErr)
	}
	count, err := jobs.CountDocuments(ctx, bson.M{"tool_call_id": "dispatch-rejected"})
	if err != nil {
		t.Fatalf("CountDocuments: %v", err)
	}
	if count != 0 {
		t.Fatalf("rejected job count = %d, want 0", count)
	}
	task := mustTaskDoc(t, taskCol, "originator-run")
	if task.RunsUsed != 1 {
		t.Fatalf("RunsUsed = %d, want unchanged 1", task.RunsUsed)
	}
}

func TestJobRepoMarkDeliveredClearsAwaitReverseLink(t *testing.T) {
	r, _, _ := newJobRepo(t)
	ctx := context.Background()
	dispatch := dispatchRequiredJob(t, r)
	await := agent.PendingAwait{
		JobID:           dispatch.JobID,
		AwaitToolCallID: "await-1",
		CreatedAt:       time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		DelegateTool:    "ask_researcher",
	}

	if err := r.MarkAwaiting(ctx, "parent-run", []agent.PendingAwait{await}); err != nil {
		t.Fatalf("MarkAwaiting: %v", err)
	}
	if err := r.MarkJobSucceeded(ctx, dispatch.JobID, "done"); err != nil {
		t.Fatalf("MarkJobSucceeded: %v", err)
	}
	if err := r.MarkDelivered(ctx, "parent-run", "user-1", []agent.AwaitJobResult{{
		JobID:        dispatch.JobID,
		Status:       string(model.JobStatusSucceeded),
		Output:       "done",
		CreatedAt:    await.CreatedAt,
		DelegateTool: "ask_researcher",
	}}, []agent.PendingAwait{await}); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}

	doc, err := r.GetJob(ctx, dispatch.JobID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if doc.DeliveredAt == nil {
		t.Fatal("DeliveredAt is nil")
	}
	if doc.DeliveredToolCallID != "await-1" {
		t.Fatalf("DeliveredToolCallID = %q, want await-1", doc.DeliveredToolCallID)
	}
	if doc.AwaitingParentRunID != "" || doc.AwaitToolCallID != "" || doc.AwaitingSince != nil {
		t.Fatalf("await reverse link was not cleared: %+v", doc)
	}

	pending, err := r.PendingRequiredJobs(ctx, "parent-run", "user-1")
	if err != nil {
		t.Fatalf("PendingRequiredJobs: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("PendingRequiredJobs = %+v, want none", pending)
	}
	ready, err := r.FindReadyWaitingRunIDs(ctx, 10)
	if err != nil {
		t.Fatalf("FindReadyWaitingRunIDs: %v", err)
	}
	if len(ready) != 0 {
		t.Fatalf("FindReadyWaitingRunIDs = %v, want none after delivery", ready)
	}
}

func TestJobRepoFindExpiredRunningJobs(t *testing.T) {
	r, jobs, _ := newJobRepo(t)
	ctx := context.Background()
	dispatch := dispatchRequiredJob(t, r)

	if _, ok, err := r.ClaimJobStarting(ctx, dispatch.JobID, "coordinator-1", time.Minute); err != nil || !ok {
		t.Fatalf("ClaimJobStarting ok=%v err=%v", ok, err)
	}
	if err := r.MarkJobDispatched(ctx, dispatch.JobID, "child-run", "child-thread"); err != nil {
		t.Fatalf("MarkJobDispatched: %v", err)
	}
	_, err := jobs.UpdateOne(ctx,
		bson.M{"job_id": dispatch.JobID},
		bson.M{"$set": bson.M{"lease_expires_at": time.Now().Add(-500 * time.Millisecond)}})
	if err != nil {
		t.Fatalf("expire lease: %v", err)
	}

	expired, err := r.FindExpiredRunningJobs(ctx, time.Now().Add(-time.Second), 10)
	if err != nil {
		t.Fatalf("FindExpiredRunningJobs within grace: %v", err)
	}
	if len(expired) != 0 {
		t.Fatalf("expired jobs inside grace = %+v, want none", expired)
	}

	expired, err = r.FindExpiredRunningJobs(ctx, time.Now(), 10)
	if err != nil {
		t.Fatalf("FindExpiredRunningJobs: %v", err)
	}
	if len(expired) != 1 || expired[0].JobID != dispatch.JobID {
		t.Fatalf("expired jobs = %+v, want %s", expired, dispatch.JobID)
	}
}

func TestJobRepoCountActiveForOriginatorCountsRunningAndUnexpiredStartingOnly(t *testing.T) {
	r, jobs, _ := newJobRepo(t)
	ctx := context.Background()
	now := time.Now()
	docs := []any{
		activeCountDoc("queued", "origin", string(model.JobStatusQueued), nil, now),
		activeCountDoc("running", "origin", string(model.JobStatusRunning), nil, now),
		activeCountDoc("starting-fresh", "origin", string(model.JobStatusStarting), ptrTime(now.Add(time.Minute)), now),
		activeCountDoc("starting-expired", "origin", string(model.JobStatusStarting), ptrTime(now.Add(-time.Minute)), now),
		activeCountDoc("other-origin", "other", string(model.JobStatusRunning), nil, now),
	}
	if _, err := jobs.InsertMany(ctx, docs); err != nil {
		t.Fatalf("InsertMany: %v", err)
	}

	count, err := r.CountActiveForOriginator(ctx, "origin")
	if err != nil {
		t.Fatalf("CountActiveForOriginator: %v", err)
	}
	if count != 2 {
		t.Fatalf("active count = %d, want 2", count)
	}
}

func TestJobRepoAcquireLockUsesCAS(t *testing.T) {
	r, _, _ := newJobRepo(t)
	ctx := context.Background()

	acquired, err := r.AcquireLock(ctx, "target", "target:o:a", "job-1", "run-1", "owner-1", -time.Second)
	if err != nil || !acquired {
		t.Fatalf("first AcquireLock acquired=%v err=%v", acquired, err)
	}
	acquired, err = r.AcquireLock(ctx, "target", "target:o:a", "job-2", "run-2", "owner-2", time.Minute)
	if err != nil || !acquired {
		t.Fatalf("expired AcquireLock acquired=%v err=%v", acquired, err)
	}
	acquired, err = r.AcquireLock(ctx, "target", "target:o:a", "job-3", "run-3", "owner-3", time.Minute)
	if err != nil {
		t.Fatalf("contended AcquireLock: %v", err)
	}
	if acquired {
		t.Fatal("contended AcquireLock acquired active non-expired lock")
	}
}

func TestJobRepoAcquireLockConcurrentExpiredLockHasSingleWinner(t *testing.T) {
	r, _, _ := newJobRepo(t)
	ctx := context.Background()

	acquired, err := r.AcquireLock(ctx, "target", "target:o:concurrent", "seed", "run-seed", "seed-owner", -time.Second)
	if err != nil || !acquired {
		t.Fatalf("seed AcquireLock acquired=%v err=%v", acquired, err)
	}

	const contenders = 16
	var wg sync.WaitGroup
	winners := make(chan string, contenders)
	for i := 0; i < contenders; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			jobID := "job-" + string(rune('a'+i))
			ok, err := r.AcquireLock(context.Background(), "target", "target:o:concurrent", jobID, "run-"+jobID, "owner-"+jobID, time.Minute)
			if err != nil {
				t.Errorf("AcquireLock contender %d: %v", i, err)
				return
			}
			if ok {
				winners <- jobID
			}
		}()
	}
	wg.Wait()
	close(winners)
	var got []string
	for jobID := range winners {
		got = append(got, jobID)
	}
	if len(got) != 1 {
		t.Fatalf("winners = %v, want exactly one", got)
	}
}

func ptrTime(t time.Time) *time.Time {
	return &t
}

func activeCountDoc(jobID, originator, status string, leaseExpires *time.Time, now time.Time) model.JobDocument {
	return model.JobDocument{
		ID:              bson.NewObjectID(),
		JobID:           jobID,
		ParentRunID:     "parent-" + jobID,
		ToolCallID:      "tool-" + jobID,
		OriginatorRunID: originator,
		Status:          status,
		LeaseExpiresAt:  leaseExpires,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}
