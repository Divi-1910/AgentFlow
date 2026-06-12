package repository_test

import (
	"context"
	"sync"
	"testing"

	"backend/agent"
	"backend/model"
	"backend/repository"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func newTaskRepo(t *testing.T) (*repository.TaskRepo, *mongo.Collection) {
	t.Helper()
	tasks := col(t, "tasks")
	r := repository.NewTaskRepo(tasks)
	if err := r.EnsureIndexes(context.Background()); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}
	return r, tasks
}

func mustTaskDoc(t *testing.T, tasks *mongo.Collection, originatorRunID string) model.TaskDocument {
	t.Helper()
	var doc model.TaskDocument
	if err := tasks.FindOne(context.Background(), bson.M{"originator_run_id": originatorRunID}).Decode(&doc); err != nil {
		t.Fatalf("find task: %v", err)
	}
	return doc
}

func TestTaskRepoEnsureTaskInitializesAndFreezesBudget(t *testing.T) {
	r, tasks := newTaskRepo(t)
	ctx := context.Background()

	if err := r.EnsureTask(ctx, "origin", "user-1", 7); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	doc := mustTaskDoc(t, tasks, "origin")
	if doc.MaxRuns != 7 || doc.RunsUsed != 0 || len(doc.RunKeys) != 0 {
		t.Fatalf("budget fields = max:%d used:%d keys:%v, want 7/0/empty", doc.MaxRuns, doc.RunsUsed, doc.RunKeys)
	}

	if err := r.EnsureTask(ctx, "origin", "user-1", 3); err != nil {
		t.Fatalf("second EnsureTask: %v", err)
	}
	doc = mustTaskDoc(t, tasks, "origin")
	if doc.MaxRuns != 7 {
		t.Fatalf("MaxRuns overwritten = %d, want frozen 7", doc.MaxRuns)
	}
}

func TestTaskRepoEnsureTaskBackfillsOldCancellationDoc(t *testing.T) {
	r, tasks := newTaskRepo(t)
	ctx := context.Background()
	if _, err := tasks.InsertOne(ctx, bson.M{
		"_id":               bson.NewObjectID(),
		"originator_run_id": "origin-old",
		"user_id":           "user-1",
	}); err != nil {
		t.Fatalf("InsertOne: %v", err)
	}

	if err := r.EnsureTask(ctx, "origin-old", "user-1", 9); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	doc := mustTaskDoc(t, tasks, "origin-old")
	if doc.MaxRuns != 9 || doc.RunsUsed != 0 || doc.RunKeys == nil {
		t.Fatalf("backfilled doc = %+v, want max_runs/runs_used/run_budget_keys", doc)
	}
}

func TestTaskRepoTryConsumeRunIsIdempotentAndExhausts(t *testing.T) {
	r, tasks := newTaskRepo(t)
	ctx := context.Background()
	if err := r.EnsureTask(ctx, "origin", "user-1", 2); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}

	status, ok, err := r.TryConsumeRun(ctx, "origin", "user-1", "key-1")
	if err != nil || !ok {
		t.Fatalf("first consume ok=%v status=%+v err=%v", ok, status, err)
	}
	status, ok, err = r.TryConsumeRun(ctx, "origin", "user-1", "key-1")
	if err != nil || !ok {
		t.Fatalf("idempotent consume ok=%v status=%+v err=%v", ok, status, err)
	}
	doc := mustTaskDoc(t, tasks, "origin")
	if doc.RunsUsed != 1 {
		t.Fatalf("RunsUsed after replay = %d, want 1", doc.RunsUsed)
	}

	if _, ok, err = r.TryConsumeRun(ctx, "origin", "user-1", "key-2"); err != nil || !ok {
		t.Fatalf("second consume ok=%v err=%v", ok, err)
	}
	status, ok, err = r.TryConsumeRun(ctx, "origin", "user-1", "key-3")
	if err != nil {
		t.Fatalf("third consume: %v", err)
	}
	if ok || !status.Exhausted || status.RunsUsed != 2 || status.MaxRuns != 2 {
		t.Fatalf("third consume ok=%v status=%+v, want exhausted at 2/2", ok, status)
	}
}

func TestTaskRepoTryConsumeRunReplayAfterExhaustionStaysAdmitted(t *testing.T) {
	r, tasks := newTaskRepo(t)
	ctx := context.Background()
	if err := r.EnsureTask(ctx, "origin", "user-1", 1); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}

	status, ok, err := r.TryConsumeRun(ctx, "origin", "user-1", "key-1")
	if err != nil || !ok {
		t.Fatalf("first consume ok=%v status=%+v err=%v", ok, status, err)
	}
	if !status.Exhausted || status.RunsUsed != 1 {
		t.Fatalf("first status = %+v, want exhausted at 1/1", status)
	}

	status, ok, err = r.TryConsumeRun(ctx, "origin", "user-1", "key-1")
	if err != nil || !ok {
		t.Fatalf("replay consume ok=%v status=%+v err=%v", ok, status, err)
	}
	if !status.Exhausted || status.RunsUsed != 1 {
		t.Fatalf("replay status = %+v, want exhausted but unchanged at 1/1", status)
	}
	doc := mustTaskDoc(t, tasks, "origin")
	if doc.RunsUsed != 1 || len(doc.RunKeys) != 1 {
		t.Fatalf("doc after replay = used:%d keys:%v, want 1/1", doc.RunsUsed, doc.RunKeys)
	}
}

func TestTaskRepoTryConsumeRunConcurrentHasMaxWinners(t *testing.T) {
	r, tasks := newTaskRepo(t)
	ctx := context.Background()
	if err := r.EnsureTask(ctx, "origin", "user-1", 5); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}

	const contenders = 24
	var wg sync.WaitGroup
	winners := make(chan string, contenders)
	errCh := make(chan error, contenders)
	for i := 0; i < contenders; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := "key-" + string(rune('a'+i))
			_, ok, err := r.TryConsumeRun(context.Background(), "origin", "user-1", key)
			if err != nil {
				errCh <- err
				return
			}
			if ok {
				winners <- key
			}
		}()
	}
	wg.Wait()
	close(winners)
	close(errCh)
	for err := range errCh {
		t.Fatalf("TryConsumeRun: %v", err)
	}
	var got []string
	for key := range winners {
		got = append(got, key)
	}
	if len(got) != 5 {
		t.Fatalf("winners = %v, want exactly 5", got)
	}
	doc := mustTaskDoc(t, tasks, "origin")
	if doc.RunsUsed != 5 || len(doc.RunKeys) != 5 {
		t.Fatalf("doc = used:%d keys:%v, want 5/5", doc.RunsUsed, doc.RunKeys)
	}
}

func TestTaskRepoCancelTaskPreservesBudget(t *testing.T) {
	r, tasks := newTaskRepo(t)
	ctx := context.Background()
	if err := r.EnsureTask(ctx, "origin", "user-1", 4); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	if _, ok, err := r.TryConsumeRun(ctx, "origin", "user-1", "key-1"); err != nil || !ok {
		t.Fatalf("TryConsumeRun ok=%v err=%v", ok, err)
	}
	if err := r.CancelTask(ctx, "origin", "cancelled"); err != nil {
		t.Fatalf("CancelTask: %v", err)
	}
	doc := mustTaskDoc(t, tasks, "origin")
	if doc.MaxRuns != 4 || doc.RunsUsed != 1 || len(doc.RunKeys) != 1 {
		t.Fatalf("budget changed after cancel: %+v", doc)
	}

	if err := r.CancelTask(ctx, "cancel-first", "cancelled"); err != nil {
		t.Fatalf("CancelTask new: %v", err)
	}
	doc = mustTaskDoc(t, tasks, "cancel-first")
	if doc.MaxRuns != agent.DefaultMaxTaskRuns || doc.RunsUsed != 0 || doc.RunKeys == nil {
		t.Fatalf("cancel-created budget = %+v, want defaults", doc)
	}
}
