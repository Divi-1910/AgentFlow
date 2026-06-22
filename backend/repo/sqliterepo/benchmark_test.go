package sqliterepo

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/memory"
	"backend/runtimectx"
)

func benchmarkDB(b *testing.B) *MessageRepo {
	b.Helper()
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		b.Fatalf("Open: %v", err)
	}
	b.Cleanup(func() { _ = db.Close() })
	return NewMessageRepo(db)
}

func BenchmarkMessageWindowRead(b *testing.B) {
	repo := benchmarkDB(b)
	messages := make([]llm.ChatMessage, 1000)
	for i := range messages {
		messages[i] = llm.ChatMessage{Role: "user", Content: fmt.Sprintf("message-%d", i)}
	}
	if _, err := repo.InsertMany(context.Background(), "thread", "agent", "user", messages); err != nil {
		b.Fatalf("InsertMany: %v", err)
	}
	b.ResetTimer()
	for range b.N {
		if _, err := repo.ListDocsByThread(context.Background(), "thread", 50); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCheckpointWrite(b *testing.B) {
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		b.Fatalf("Open: %v", err)
	}
	b.Cleanup(func() { _ = db.Close() })
	repo := NewRunRepo(db)
	if err := repo.CreateRun(context.Background(), "run", "thread", "agent", "user"); err != nil {
		b.Fatalf("CreateRun: %v", err)
	}
	snapshot := agent.RunSnapshot{
		Version: 1, RunID: "run",
		State: agent.RuntimeState{Messages: []llm.ChatMessage{{Role: "user", Content: "hello"}}, MaxSteps: b.N + 1},
	}
	b.ResetTimer()
	for i := range b.N {
		snapshot.State.StepsCompleted = i
		if err := repo.Save(context.Background(), snapshot); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkMemoryVisibilityQuery(b *testing.B) {
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		b.Fatalf("Open: %v", err)
	}
	b.Cleanup(func() { _ = db.Close() })
	repo := NewMemoryMetaRepo(db)
	scope := runtimectx.MemoryScope{UserID: "user", AgentID: "agent", ThreadID: "thread"}
	now := time.Now().UTC()
	for i := 0; i < memory.MaxScannedFiles; i++ {
		doc := memory.MemoryDocument{
			UserID: scope.UserID, AgentID: scope.AgentID, ThreadID: scope.ThreadID,
			ID: fmt.Sprintf("memory-%d", i), Scope: memory.ScopeThread, Type: memory.TypeFact,
			Revision: 1, CreatedAt: now, UpdatedAt: now,
		}
		if err := repo.Upsert(context.Background(), doc); err != nil {
			b.Fatalf("Upsert: %v", err)
		}
	}
	b.ResetTimer()
	for range b.N {
		if _, err := repo.FindActive(context.Background(), scope, memory.ScopeUser, nil, false, now); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkConcurrentBudgetConsumption(b *testing.B) {
	db, err := Open(":memory:", Options{JournalMode: "MEMORY"})
	if err != nil {
		b.Fatalf("Open: %v", err)
	}
	b.Cleanup(func() { _ = db.Close() })
	repo := NewTaskRepo(db)
	if err := repo.EnsureTask(context.Background(), "origin", "user", 1_000_000_000); err != nil {
		b.Fatalf("EnsureTask: %v", err)
	}
	var key atomic.Int64
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			id := key.Add(1)
			if _, ok, err := repo.TryConsumeRun(context.Background(), "origin", "user", fmt.Sprintf("key-%d", id)); err != nil || !ok {
				b.Errorf("TryConsumeRun: ok=%v err=%v", ok, err)
			}
		}
	})
}
