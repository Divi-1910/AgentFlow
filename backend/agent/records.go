package agent

import (
	"time"

	"backend/llm"
)

// ThreadRecord is the storage-neutral representation of a conversation thread.
// IDs are opaque strings, never a driver-specific type, so any backend — Mongo
// for the Studio today, SQLite for the Runtime later — can satisfy the thread
// store contract by translating its rows at the edge. The Mongo adapter happens
// to render ObjectIDs as hex; the contract requires no particular id format. It
// mirrors the persisted thread; the Studio's HTTP layer maps it to its own DTO.
type ThreadRecord struct {
	ID      string
	UserID  string
	AgentID string
	// Kind is "" for user-facing threads and "sub" for delegate sub-threads.
	// OriginatorRunID ties a sub-thread to the top-level run it belongs to.
	Kind            string
	OriginatorRunID string
	Title           string
	Summary         string
	Metadata        map[string]any
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// MessageRecord is the storage-neutral representation of a stored chat message.
// IDs are opaque strings (the Mongo adapter renders ObjectIDs as hex; the
// contract does not require it); ToolCalls reuses the llm.ToolCall domain type,
// so a record round-trips a persisted message without any driver dependency.
type MessageRecord struct {
	ID         string
	ThreadID   string
	AgentID    string
	UserID     string
	Role       string
	Content    string
	ToolCallID string
	ToolCalls  []llm.ToolCall
	ToolName   string
	Metadata   map[string]any
	CreatedAt  time.Time
}

// JobRecord is the storage-neutral representation of an async job. IDs are
// opaque strings; a backend translates its own document/row shape into this at
// the edge (the Mongo adapter's model.JobDocument is one such shape). Status
// and CallbackStatus track two independent lifecycles — the delegated job
// itself, and (for background jobs) the callback run that notifies the user —
// so CallbackError is a distinct field from Error: a callback failure must
// never overwrite the job's own outcome.
type JobRecord struct {
	JobID           string
	ParentRunID     string
	OriginatorRunID string
	ParentThreadID  string
	ParentAgentID   string
	UserID          string

	ToolCallID          string
	DelegateTool        string
	TargetAgentID       string
	Task                string
	Mode                string
	CallbackInstruction string
	DelegationChain     []string
	DelegationDepth     int

	Status string
	Output string
	Error  string

	ChildRunID    string
	ChildThreadID string

	AwaitingParentRunID string
	AwaitToolCallID     string
	AwaitingSince       *time.Time
	DeliveredAt         *time.Time
	DeliveredToolCallID string

	CallbackStatus string
	CallbackRunID  string
	CallbackError  string

	LeaseOwner     string
	LeaseExpiresAt *time.Time

	CreatedAt  time.Time
	UpdatedAt  time.Time
	StartedAt  time.Time
	FinishedAt time.Time
}
