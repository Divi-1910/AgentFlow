package mongorepo_test

import (
	"context"
	"testing"

	"backend/repo/mongorepo"
)

const (
	threadUserID  = "507f1f77bcf86cd799439011"
	threadOtherID = "507f1f77bcf86cd799439099"
	agentAID      = "507f1f77bcf86cd799439012"
	agentBID      = "507f1f77bcf86cd799439013"
)

func TestThreadRepoCreateAndGetByID(t *testing.T) {
	r := mongorepo.NewThreadRepo(col(t, "threads"))
	ctx := context.Background()

	thread, err := r.Create(ctx, threadUserID, agentAID, "my thread")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if thread.Title != "my thread" {
		t.Errorf("Title: got %q, want %q", thread.Title, "my thread")
	}
	if thread.ID == "" {
		t.Fatal("expected non-zero ID")
	}

	got, err := r.GetByID(ctx, thread.ID, threadUserID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != thread.ID {
		t.Errorf("ID mismatch: got %v, want %v", got.ID, thread.ID)
	}
}

func TestThreadRepoCreateDefaultsEmptyTitle(t *testing.T) {
	r := mongorepo.NewThreadRepo(col(t, "threads"))
	ctx := context.Background()

	thread, err := r.Create(ctx, threadUserID, agentAID, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if thread.Title != "New Thread" {
		t.Errorf("Title: got %q, want %q", thread.Title, "New Thread")
	}
}

func TestThreadRepoGetByIDWrongUserReturnsNotFound(t *testing.T) {
	r := mongorepo.NewThreadRepo(col(t, "threads"))
	ctx := context.Background()

	thread, err := r.Create(ctx, threadUserID, agentAID, "private")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	_, err = r.GetByID(ctx, thread.ID, threadOtherID)
	if err == nil {
		t.Fatal("expected error for wrong user, got nil")
	}
	if err.Error() != "thread not found" {
		t.Errorf("err: got %q, want %q", err.Error(), "thread not found")
	}
}

func TestThreadRepoListByAgentScoped(t *testing.T) {
	r := mongorepo.NewThreadRepo(col(t, "threads"))
	ctx := context.Background()

	for _, title := range []string{"t1", "t2"} {
		if _, err := r.Create(ctx, threadUserID, agentAID, title); err != nil {
			t.Fatalf("Create(%s): %v", title, err)
		}
	}
	if _, err := r.Create(ctx, threadUserID, agentBID, "other"); err != nil {
		t.Fatalf("Create(agentB): %v", err)
	}

	threads, err := r.ListByAgent(ctx, agentAID, threadUserID)
	if err != nil {
		t.Fatalf("ListByAgent: %v", err)
	}
	if len(threads) != 2 {
		t.Errorf("expected 2 threads for agentA, got %d", len(threads))
	}

	threadsB, err := r.ListByAgent(ctx, agentBID, threadUserID)
	if err != nil {
		t.Fatalf("ListByAgent(B): %v", err)
	}
	if len(threadsB) != 1 {
		t.Errorf("expected 1 thread for agentB, got %d", len(threadsB))
	}
}

func TestThreadRepoUpdateSummaryPersists(t *testing.T) {
	r := mongorepo.NewThreadRepo(col(t, "threads"))
	ctx := context.Background()

	thread, err := r.Create(ctx, threadUserID, agentAID, "summarize me")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := r.UpdateSummary(ctx, thread.ID, threadUserID, "this is the summary"); err != nil {
		t.Fatalf("UpdateSummary: %v", err)
	}

	got, err := r.GetByID(ctx, thread.ID, threadUserID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Summary != "this is the summary" {
		t.Errorf("Summary: got %q, want %q", got.Summary, "this is the summary")
	}
}
