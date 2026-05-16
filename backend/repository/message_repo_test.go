package repository_test

import (
	"context"
	"testing"
	"time"

	"backend/llm"
	"backend/repository"
)

const (
	msgThreadID = "507f1f77bcf86cd799439011"
	msgAgentID  = "507f1f77bcf86cd799439012"
	msgUserID   = "507f1f77bcf86cd799439013"
)

func TestMessageRepoInsertManyAndListInOrder(t *testing.T) {
	r := repository.NewMessageRepo(col(t, "messages"))
	ctx := context.Background()

	// Insert in two separate calls with a gap so MongoDB's millisecond-precision
	// timestamps are distinct, making the sort order deterministic.
	if _, err := r.InsertMany(ctx, msgThreadID, msgAgentID, msgUserID,
		[]llm.ChatMessage{{Role: "user", Content: "hello"}}); err != nil {
		t.Fatalf("InsertMany(user): %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := r.InsertMany(ctx, msgThreadID, msgAgentID, msgUserID,
		[]llm.ChatMessage{{Role: "assistant", Content: "hi there"}}); err != nil {
		t.Fatalf("InsertMany(assistant): %v", err)
	}

	listed, err := r.ListDocsByThread(ctx, msgThreadID, 100)
	if err != nil {
		t.Fatalf("ListDocsByThread: %v", err)
	}
	if len(listed) != 2 {
		t.Fatalf("ListDocsByThread: expected 2, got %d", len(listed))
	}
	// ListDocsByThread sorts by created_at DESC then reverses → chronological (oldest first).
	if listed[0].Role != "user" {
		t.Errorf("first message role: got %q, want %q", listed[0].Role, "user")
	}
	if listed[1].Role != "assistant" {
		t.Errorf("second message role: got %q, want %q", listed[1].Role, "assistant")
	}
}

func TestMessageRepoListDocsByThreadRespectsLimit(t *testing.T) {
	r := repository.NewMessageRepo(col(t, "messages"))
	ctx := context.Background()

	msgs := make([]llm.ChatMessage, 5)
	for i := range msgs {
		msgs[i] = llm.ChatMessage{Role: "user", Content: "msg"}
	}
	if _, err := r.InsertMany(ctx, msgThreadID, msgAgentID, msgUserID, msgs); err != nil {
		t.Fatalf("InsertMany: %v", err)
	}

	listed, err := r.ListDocsByThread(ctx, msgThreadID, 3)
	if err != nil {
		t.Fatalf("ListDocsByThread: %v", err)
	}
	if len(listed) != 3 {
		t.Errorf("expected 3 with limit=3, got %d", len(listed))
	}
}

func TestMessageRepoListRecentByThreadReturnsChatMessages(t *testing.T) {
	r := repository.NewMessageRepo(col(t, "messages"))
	ctx := context.Background()

	// Separate inserts with a gap to ensure distinct millisecond timestamps.
	if _, err := r.InsertMany(ctx, msgThreadID, msgAgentID, msgUserID,
		[]llm.ChatMessage{{Role: "user", Content: "question"}}); err != nil {
		t.Fatalf("InsertMany(user): %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := r.InsertMany(ctx, msgThreadID, msgAgentID, msgUserID,
		[]llm.ChatMessage{{Role: "assistant", Content: "answer"}}); err != nil {
		t.Fatalf("InsertMany(assistant): %v", err)
	}

	recent, err := r.ListRecentByThread(ctx, msgThreadID, 100)
	if err != nil {
		t.Fatalf("ListRecentByThread: %v", err)
	}
	if len(recent) != 2 {
		t.Fatalf("expected 2, got %d", len(recent))
	}
	if recent[0].Role != "user" || recent[0].Content != "question" {
		t.Errorf("first: got role=%q content=%q, want role=user content=question", recent[0].Role, recent[0].Content)
	}
	if recent[1].Role != "assistant" || recent[1].Content != "answer" {
		t.Errorf("second: got role=%q content=%q, want role=assistant content=answer", recent[1].Role, recent[1].Content)
	}
}

func TestMessageRepoEmptyThreadReturnsEmptySlice(t *testing.T) {
	r := repository.NewMessageRepo(col(t, "messages"))
	ctx := context.Background()

	docs, err := r.ListDocsByThread(ctx, msgThreadID, 50)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(docs) != 0 {
		t.Errorf("expected empty slice, got %d docs", len(docs))
	}
}

func TestMessageRepoInsertManyPreservesToolCallID(t *testing.T) {
	r := repository.NewMessageRepo(col(t, "messages"))
	ctx := context.Background()

	msgs := []llm.ChatMessage{
		{Role: "tool", Content: "tool result", ToolCallID: "call_abc123"},
	}
	if _, err := r.InsertMany(ctx, msgThreadID, msgAgentID, msgUserID, msgs); err != nil {
		t.Fatalf("InsertMany: %v", err)
	}

	docs, err := r.ListDocsByThread(ctx, msgThreadID, 10)
	if err != nil {
		t.Fatalf("ListDocsByThread: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected 1 doc, got %d", len(docs))
	}
	if docs[0].ToolCallID != "call_abc123" {
		t.Errorf("ToolCallID: got %q, want %q", docs[0].ToolCallID, "call_abc123")
	}
}
