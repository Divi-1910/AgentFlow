package sqliterepo

import (
	"context"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/memory"
	"backend/model"
)

func TestRunCheckpointRetentionTimestamps(t *testing.T) {
	db := testDBInternal(t)
	repo := NewRunRepo(db)
	ctx := context.Background()
	if err := repo.CreateRun(ctx, "retention", "t", "a", "u"); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	snap := agent.RunSnapshot{
		Version: 1, RunID: "retention",
		State: agent.RuntimeState{Messages: []llm.ChatMessage{{Role: "user", Content: "hi"}}, StepsCompleted: 1},
	}
	if err := repo.Save(ctx, snap); err != nil {
		t.Fatalf("Save: %v", err)
	}
	before := time.Now().UTC()
	if err := repo.UpdateStatus(ctx, "retention", string(model.RunStatusCompleted), ""); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	var expires int64
	if err := db.QueryRow(`SELECT expires_at FROM run_checkpoints WHERE run_id = ?`, "retention").Scan(&expires); err != nil {
		t.Fatalf("expires_at: %v", err)
	}
	got := timeFromUnixNano(expires)
	if got.Before(before.Add(retentionCompleted)) || got.After(time.Now().UTC().Add(retentionCompleted+time.Second)) {
		t.Fatalf("completed retention = %s", got)
	}
}

func TestRejectedTaskKeyIsNotStored(t *testing.T) {
	db := testDBInternal(t)
	repo := NewTaskRepo(db)
	ctx := context.Background()
	if err := repo.EnsureTask(ctx, "task", "u", 1); err != nil {
		t.Fatalf("EnsureTask: %v", err)
	}
	if _, ok, err := repo.TryConsumeRun(ctx, "task", "u", "accepted"); err != nil || !ok {
		t.Fatalf("accepted: ok=%v err=%v", ok, err)
	}
	if _, ok, err := repo.TryConsumeRun(ctx, "task", "u", "rejected"); err != nil || ok {
		t.Fatalf("rejected: ok=%v err=%v", ok, err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM task_run_keys WHERE budget_key = 'rejected'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rejected key count = %d, err=%v", count, err)
	}
}

func TestConstraintCodeClassification(t *testing.T) {
	db := testDBInternal(t)
	now := unixNano(time.Now())
	insert := func() error {
		_, err := db.Exec(`INSERT INTO threads(id, user_id, agent_id, title, created_at, updated_at) VALUES('same','u','a','t',?,?)`, now, now)
		return err
	}
	if err := insert(); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	err := insert()
	code, ok := constraintCode(err)
	if err == nil || !ok || code&0xff != 19 {
		t.Fatalf("constraintCode(%v) = %d, %v", err, code, ok)
	}
}

func TestMemoryRevisionConstraintRecovery(t *testing.T) {
	db := testDBInternal(t)
	repo := NewMemoryRevisionRepo(db)
	ctx := context.Background()
	base := memory.MemoryRevision{
		LineageKey: "lineage", Revision: 1, MutationID: "mutation", RunID: "run",
		ToolCallID: "call", Operation: memory.OperationCreate, UserID: "u", AgentID: "a",
		ThreadID: "t", MemoryID: "m", Scope: memory.ScopeUser, Type: memory.TypeFact,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if _, replay, err := repo.Append(ctx, base); err != nil || replay {
		t.Fatalf("first append: replay=%v err=%v", replay, err)
	}
	changed := base
	changed.Revision = 99
	if got, replay, err := repo.Append(ctx, changed); err != nil || !replay || got.Revision != 1 {
		t.Fatalf("mutation recovery: got=%+v replay=%v err=%v", got, replay, err)
	}
	collision := base
	collision.MutationID = "other"
	if _, replay, err := repo.Append(ctx, collision); err != memory.ErrRevisionConflict || replay {
		t.Fatalf("revision collision: replay=%v err=%v", replay, err)
	}
}

func TestMessageJSONCorruptionReturnsDecodeError(t *testing.T) {
	db := testDBInternal(t)
	now := unixNano(time.Now())
	_, err := db.Exec(`INSERT INTO messages(id, thread_id, agent_id, user_id, role, content, tool_calls_json, created_at)
VALUES('m','t','a','u','assistant','bad','{',?)`, now)
	if err != nil {
		t.Fatalf("insert corrupt message: %v", err)
	}
	_, err = NewMessageRepo(db).ListDocsByThread(context.Background(), "t", 1)
	if err == nil || !strings.Contains(err.Error(), "decode JSON") {
		t.Fatalf("ListDocsByThread error = %v", err)
	}
}

func TestMalformedCheckpointBlobReturnsDecompressionError(t *testing.T) {
	db := testDBInternal(t)
	now := unixNano(time.Now())
	_, err := db.Exec(`INSERT INTO run_checkpoints(run_id, step, snapshot_gz, created_at) VALUES('bad',1,?,?)`, []byte("not gzip"), now)
	if err != nil {
		t.Fatalf("insert malformed checkpoint: %v", err)
	}
	_, err = NewRunRepo(db).LoadLatest(context.Background(), "bad")
	if err == nil || !strings.Contains(err.Error(), "decompress checkpoint") {
		t.Fatalf("LoadLatest error = %v", err)
	}
}
