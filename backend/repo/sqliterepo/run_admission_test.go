package sqliterepo_test

import (
	"context"
	"errors"
	"testing"

	"backend/agent"
	"backend/model"
	"backend/repo/sqliterepo"
)

func TestRunRepoAdmissionIsIdempotentAndSerializesThread(t *testing.T) {
	t.Parallel()
	repo := sqliterepo.NewRunRepo(testDB(t))
	ctx := context.Background()
	first := agent.RunAdmission{RunID: "run-1", ThreadID: "thread-1", AgentID: "agent-1", UserID: "user-1", SubmissionKey: "key-1", AcceptedInput: "hello"}

	result, err := repo.AdmitTopLevelRun(ctx, first)
	if err != nil || !result.Created || result.Run.RunID != first.RunID {
		t.Fatalf("first admission = %#v, err=%v", result, err)
	}
	replay, err := repo.AdmitTopLevelRun(ctx, agent.RunAdmission{RunID: "ignored", ThreadID: first.ThreadID, AgentID: first.AgentID, UserID: first.UserID, SubmissionKey: first.SubmissionKey, AcceptedInput: first.AcceptedInput})
	if err != nil || !replay.Replayed || replay.Run.RunID != first.RunID {
		t.Fatalf("replay = %#v, err=%v", replay, err)
	}
	_, err = repo.AdmitTopLevelRun(ctx, agent.RunAdmission{RunID: "run-2", ThreadID: first.ThreadID, AgentID: first.AgentID, UserID: first.UserID, SubmissionKey: first.SubmissionKey, AcceptedInput: "changed"})
	if !errors.Is(err, agent.ErrSubmissionKeyConflict) {
		t.Fatalf("changed replay err = %v, want submission conflict", err)
	}
	active, err := repo.AdmitTopLevelRun(ctx, agent.RunAdmission{RunID: "run-3", ThreadID: first.ThreadID, AgentID: first.AgentID, UserID: first.UserID, SubmissionKey: "key-2", AcceptedInput: "next"})
	if !errors.Is(err, agent.ErrThreadRunActive) || active.ActiveRun != first.RunID {
		t.Fatalf("active admission = %#v, err=%v", active, err)
	}
}

func TestRunRepoCancellationFencesLateCompletionAndReleasesSlot(t *testing.T) {
	t.Parallel()
	repo := sqliterepo.NewRunRepo(testDB(t))
	ctx := context.Background()
	in := agent.RunAdmission{RunID: "run-cancel", ThreadID: "thread-1", AgentID: "agent-1", UserID: "user-1", SubmissionKey: "key-1", AcceptedInput: "hello"}
	if _, err := repo.AdmitTopLevelRun(ctx, in); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := repo.RequestCancelForUser(ctx, in.RunID, in.UserID); err != nil || !claimed {
		t.Fatalf("request cancel: claimed=%v err=%v", claimed, err)
	}
	if err := repo.UpdateStatus(ctx, in.RunID, string(model.RunStatusCompleted), ""); err != nil {
		t.Fatal(err)
	}
	info, err := repo.GetRun(ctx, in.RunID)
	if err != nil || info.Status != string(model.RunStatusCancelling) {
		t.Fatalf("late completion overwrote cancellation: info=%#v err=%v", info, err)
	}
	if applied, err := repo.FinalizeCancelForUser(ctx, in.RunID, in.UserID); err != nil || !applied {
		t.Fatalf("finalize cancel: applied=%v err=%v", applied, err)
	}
	if _, err := repo.AdmitTopLevelRun(ctx, agent.RunAdmission{RunID: "run-next", ThreadID: in.ThreadID, AgentID: in.AgentID, UserID: in.UserID, SubmissionKey: "key-2", AcceptedInput: "next"}); err != nil {
		t.Fatalf("slot was not released: %v", err)
	}
}

func TestMessageRepoInsertUserPromptIsIdempotent(t *testing.T) {
	t.Parallel()
	db := testDB(t)
	repo := sqliterepo.NewMessageRepo(db)
	ctx := context.Background()
	first, created, err := repo.InsertUserPrompt(ctx, "thread", "agent", "user", "run", "hello")
	if err != nil || !created {
		t.Fatalf("first prompt: created=%v err=%v", created, err)
	}
	second, created, err := repo.InsertUserPrompt(ctx, "thread", "agent", "user", "run", "hello")
	if err != nil || created || second.ID != first.ID {
		t.Fatalf("second prompt: %#v created=%v err=%v", second, created, err)
	}
	messages, err := repo.ListDocsByThread(ctx, "thread", 10)
	if err != nil || len(messages) != 1 {
		t.Fatalf("messages=%#v err=%v", messages, err)
	}
}

func TestRunRepoRecoveryPreservesAcceptedUndispatchedRunForRetry(t *testing.T) {
	t.Parallel()
	repo := sqliterepo.NewRunRepo(testDB(t))
	ctx := context.Background()
	in := agent.RunAdmission{
		RunID: "run-pending", ThreadID: "thread-1", AgentID: "agent-1", UserID: "user-1",
		SubmissionKey: "key-pending", AcceptedInput: "hello",
	}
	if _, err := repo.AdmitTopLevelRun(ctx, in); err != nil {
		t.Fatal(err)
	}
	recovery, err := repo.RecoverOrphanedRuns(ctx, in.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Interrupted != 0 || recovery.Failed != 0 || recovery.Cancelled != 0 {
		t.Fatalf("recovery = %+v, want no orphan transition", recovery)
	}
	info, err := repo.GetRun(ctx, in.RunID)
	if err != nil || info.Status != string(model.RunStatusRunning) || info.DispatchStarted {
		t.Fatalf("pending run = %#v, err=%v", info, err)
	}
	claimed, err := repo.ClaimRunDispatch(ctx, in.RunID)
	if err != nil || !claimed {
		t.Fatalf("retry dispatch claim = %v, err=%v", claimed, err)
	}
}

func TestRunRepoPublicCancellationDoesNotMutateChildRun(t *testing.T) {
	t.Parallel()
	repo := sqliterepo.NewRunRepo(testDB(t))
	ctx := context.Background()
	if err := repo.CreateChildRun(ctx, "child", "sub-thread", "agent-2", "user-1", "root", "root"); err != nil {
		t.Fatal(err)
	}
	info, claimed, err := repo.RequestCancelForUser(ctx, "child", "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if claimed || info.Status != string(model.RunStatusRunning) {
		t.Fatalf("child cancellation = info %#v claimed %v", info, claimed)
	}
}
