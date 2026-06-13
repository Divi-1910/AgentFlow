package memory

import (
	"context"
	"errors"
	"time"

	"backend/runtimectx"
)

const (
	DocumentVersion = 1

	ScopeThread = "thread"
	ScopeAgent  = "agent"
	ScopeUser   = "user"

	TypeFact       = "fact"
	TypePreference = "preference"
	TypeProcedure  = "procedure"
	TypeEpisode    = "episode"
)

const (
	DefaultSearchLimit   = 5
	MaxSearchLimit       = 20
	DefaultMaxBodyBytes  = 8 * 1024
	DefaultMaxFileBytes  = 12 * 1024
	MaxScannedFiles      = 500
	DefaultSearchTimeout = 5 * time.Second
	MaxSegmentLen        = 128
)

var (
	ErrInvalidScope             = errors.New("invalid memory scope")
	ErrInvalidType              = errors.New("invalid memory type")
	ErrInvalidDocument          = errors.New("invalid memory document")
	ErrExpiredMemory            = errors.New("memory expired")
	ErrMemoryNotFound           = errors.New("memory not found")
	ErrMemoryExists             = errors.New("memory already exists")
	ErrRetiredMemory            = errors.New("memory retired")
	ErrExpectedRevisionRequired = errors.New("expected_revision is required")
	ErrRevisionConflict         = errors.New("memory revision conflict")
	ErrMutationIDRequired       = errors.New("run_id and tool_call_id are required")
)

// Config holds all tunable parameters for the memory service.
type Config struct {
	Root               string
	RGPath             string
	MaxBodyBytes       int
	MaxFileBytes       int
	SearchTimeout      time.Duration
	ReadWindowDuration time.Duration // how long a memory_read stamp is valid; default 5 minutes
}

// MemoryDocument is the in-memory representation of a memory record.
// Metadata is stored in MongoDB; Body is the plain-text content from disk.
type MemoryDocument struct {
	LineageKey string
	UserID     string
	AgentID    string
	ThreadID   string
	ID         string
	Type       string
	Scope      string
	Importance float64
	Revision   int
	BodySHA    string
	CreatedAt  time.Time
	UpdatedAt  time.Time
	ExpiresAt  *time.Time
	RetiredAt  *time.Time
	LastReadAt *time.Time
	// Summary is a short preview (first non-empty stripped line of the body,
	// capped at SummaryMaxChars). Stored in the metadata so the ContextBuilder
	// can render <memories><index> entries without per-request file I/O.
	Summary string
	Body    string // populated only after reading the file
}

type MemoryRevision struct {
	LineageKey   string
	Revision     int
	MutationID   string
	RunID        string
	ToolCallID   string
	Operation    string
	Reason       string
	RestoredFrom *int
	UserID       string
	AgentID      string
	ThreadID     string
	MemoryID     string
	Scope        string
	Type         string
	Importance   float64
	BodySHA      string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	ExpiresAt    *time.Time
	RetiredAt    *time.Time
}

const (
	OperationCreate  = "create"
	OperationPatch   = "patch"
	OperationUpdate  = "update"
	OperationRetire  = "retire"
	OperationRestore = "restore"
)

// SummaryMaxChars caps the length of the Summary preview stored alongside
// memory metadata.
const SummaryMaxChars = 200

// MetaStore is the persistence interface for memory metadata.
// The concrete implementation stores records in MongoDB.
// A lightweight in-memory fake is used in unit tests.
type MetaStore interface {
	// Upsert creates or updates the metadata record for a memory document.
	// It must NOT overwrite last_read_at — that field is managed exclusively
	// by StampRead.
	Upsert(ctx context.Context, doc MemoryDocument) error

	// FindActive returns all non-expired metadata records visible within the
	// given searchScope, honouring the scope-expansion rules:
	//   thread → thread only
	//   agent  → agent + thread
	//   user   → user + agent + thread
	FindActive(ctx context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, includeRetired bool, now time.Time) ([]MemoryDocument, error)

	// StampRead records the current time as last_read_at for a projected
	// memory row. Only updates existing records; never creates a new one.
	StampRead(ctx context.Context, doc MemoryDocument) error

	// FindExpired is retained for legacy repository tests and older callers.
	// Versioned memory expiry is enforced by read/search, not cleanup.
	FindExpired(ctx context.Context, now time.Time) ([]MemoryDocument, error)

	// SoftDelete is retained for legacy repository tests and older callers.
	// Versioned memories are retired by appending a revision instead.
	SoftDelete(ctx context.Context, agentID, scope, memoryID string) error

	// EnsureIndexes creates the required MongoDB indexes (idempotent).
	EnsureIndexes(ctx context.Context) error
}

type RevisionStore interface {
	Append(ctx context.Context, rev MemoryRevision) (*MemoryRevision, bool, error)
	FindByMutation(ctx context.Context, mutationID string) (*MemoryRevision, error)
	Latest(ctx context.Context, lineageKey string) (*MemoryRevision, error)
	FindRevision(ctx context.Context, lineageKey string, revision int) (*MemoryRevision, error)
	List(ctx context.Context, lineageKey string) ([]MemoryRevision, error)
	EnsureIndexes(ctx context.Context) error
}

// ── Args / Results ────────────────────────────────────────────────────────────

type MemoryWriteArgs struct {
	MemoryID   string  `json:"memory_id,omitempty"`
	Content    string  `json:"content"`
	Type       string  `json:"type"`
	Scope      string  `json:"scope"`
	Importance float64 `json:"importance"`
	TTLDays    *int    `json:"ttl_days,omitempty"`
	RunID      string  `json:"-"`
	ToolCallID string  `json:"-"`
}

type MemorySearchArgs struct {
	Pattern        string  `json:"pattern"`
	Scope          string  `json:"scope"`
	Type           *string `json:"type,omitempty"`
	Limit          *int    `json:"limit,omitempty"`
	IncludeRetired bool    `json:"include_retired,omitempty"`
}

type MemoryReadArgs struct {
	MemoryID string `json:"memory_id"`
	Scope    string `json:"scope"`
	Revision *int   `json:"revision,omitempty"`
}

type MemoryPatchEdit struct {
	OldText string `json:"old_text"`
	NewText string `json:"new_text"`
}

type MemoryPatchArgs struct {
	MemoryID         string            `json:"memory_id"`
	Scope            string            `json:"scope"`
	ExpectedRevision *int              `json:"expected_revision,omitempty"`
	Reason           string            `json:"reason"`
	Edits            []MemoryPatchEdit `json:"edits"`
	RunID            string            `json:"-"`
	ToolCallID       string            `json:"-"`
}

type MemoryUpdateArgs struct {
	MemoryID         string `json:"memory_id"`
	Scope            string `json:"scope"`
	ExpectedRevision *int   `json:"expected_revision,omitempty"`
	Reason           string `json:"reason"`
	Content          string `json:"content"`
	RunID            string `json:"-"`
	ToolCallID       string `json:"-"`
}

type MemoryRetireArgs struct {
	MemoryID         string `json:"memory_id"`
	Scope            string `json:"scope"`
	ExpectedRevision *int   `json:"expected_revision,omitempty"`
	Reason           string `json:"reason"`
	RunID            string `json:"-"`
	ToolCallID       string `json:"-"`
}

type MemoryRestoreArgs struct {
	MemoryID         string `json:"memory_id"`
	Scope            string `json:"scope"`
	ExpectedRevision *int   `json:"expected_revision,omitempty"`
	FromRevision     *int   `json:"from_revision,omitempty"`
	Reason           string `json:"reason"`
	RunID            string `json:"-"`
	ToolCallID       string `json:"-"`
}

type MemoryHistoryArgs struct {
	MemoryID string `json:"memory_id"`
	Scope    string `json:"scope"`
}

type WriteResult struct {
	MemoryID  string  `json:"memory_id"`
	Scope     string  `json:"scope"`
	Revision  int     `json:"revision"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
	ExpiresAt *string `json:"expires_at,omitempty"`
}

type MutationResult struct {
	MemoryID  string  `json:"memory_id"`
	Scope     string  `json:"scope"`
	Revision  int     `json:"revision"`
	Retired   bool    `json:"retired"`
	UpdatedAt string  `json:"updated_at"`
	ExpiresAt *string `json:"expires_at,omitempty"`
}

type SearchResult struct {
	MemoryID   string  `json:"memory_id"`
	Snippet    string  `json:"snippet"`
	Type       string  `json:"type"`
	Scope      string  `json:"scope"`
	Importance float64 `json:"importance"`
	Revision   int     `json:"revision"`
	Retired    bool    `json:"retired"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

type SearchResponse struct {
	Results []SearchResult `json:"results"`
}

type ReadResult struct {
	MemoryID   string  `json:"memory_id"`
	Content    string  `json:"content"`
	Type       string  `json:"type"`
	Scope      string  `json:"scope"`
	AgentID    string  `json:"agent_id"`
	ThreadID   string  `json:"thread_id"`
	Importance float64 `json:"importance"`
	Revision   int     `json:"revision"`
	Retired    bool    `json:"retired"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
}

type HistoryRevision struct {
	Revision     int     `json:"revision"`
	Operation    string  `json:"operation"`
	Reason       string  `json:"reason,omitempty"`
	RestoredFrom *int    `json:"restored_from,omitempty"`
	BodySHA      string  `json:"body_sha"`
	Type         string  `json:"type"`
	Importance   float64 `json:"importance"`
	Retired      bool    `json:"retired"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	ExpiresAt    *string `json:"expires_at,omitempty"`
	RetiredAt    *string `json:"retired_at,omitempty"`
}

type HistoryResponse struct {
	MemoryID  string            `json:"memory_id"`
	Scope     string            `json:"scope"`
	Revisions []HistoryRevision `json:"revisions"`
}

// ── Config helpers ────────────────────────────────────────────────────────────

func (c Config) withDefaults() Config {
	if c.RGPath == "" {
		c.RGPath = "rg"
	}
	if c.MaxBodyBytes <= 0 {
		c.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if c.MaxFileBytes <= 0 {
		c.MaxFileBytes = DefaultMaxFileBytes
	}
	if c.SearchTimeout <= 0 {
		c.SearchTimeout = DefaultSearchTimeout
	}
	if c.ReadWindowDuration <= 0 {
		c.ReadWindowDuration = 5 * time.Minute
	}
	return c
}

// ── Validation helpers ────────────────────────────────────────────────────────

func validScope(scope string) bool {
	switch scope {
	case ScopeThread, ScopeAgent, ScopeUser:
		return true
	default:
		return false
	}
}

func validType(memoryType string) bool {
	switch memoryType {
	case TypeFact, TypePreference, TypeProcedure, TypeEpisode:
		return true
	default:
		return false
	}
}
