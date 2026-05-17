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
	ErrInvalidScope    = errors.New("invalid memory scope")
	ErrInvalidType     = errors.New("invalid memory type")
	ErrInvalidDocument = errors.New("invalid memory document")
	ErrExpiredMemory   = errors.New("memory expired")
	ErrMemoryNotFound  = errors.New("memory not found")
	ErrReadBeforeWrite = errors.New("memory: read before write required")
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
	UserID     string
	AgentID    string
	ThreadID   string
	ID         string
	Type       string
	Scope      string
	Importance float64
	CreatedAt  time.Time
	ExpiresAt  *time.Time
	LastReadAt *time.Time
	Body       string // populated only after reading the file
}

// MetaStore is the persistence interface for memory metadata.
// The concrete implementation stores records in MongoDB.
// A lightweight in-memory fake is used in unit tests.
type MetaStore interface {
	// Upsert creates or updates the metadata record for a memory document.
	// It must NOT overwrite last_read_at — that field is managed exclusively
	// by StampRead.
	Upsert(ctx context.Context, doc MemoryDocument) error

	// FindOne returns the metadata record for (agentID, scope, memoryID),
	// or (nil, nil) when no record exists.
	FindOne(ctx context.Context, agentID, scope, memoryID string) (*MemoryDocument, error)

	// FindActive returns all non-expired metadata records visible within the
	// given searchScope, honouring the scope-expansion rules:
	//   thread → thread only
	//   agent  → agent + thread
	//   user   → user + agent + thread
	FindActive(ctx context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, now time.Time) ([]MemoryDocument, error)

	// StampRead records the current time as last_read_at for (agentID, scope,
	// memoryID). Only updates existing records; never creates a new one.
	StampRead(ctx context.Context, agentID, scope, memoryID string) error

	// FindExpired returns all non-soft-deleted metadata records where expires_at
	// is set and is on or before now. Used by the cleanup worker.
	FindExpired(ctx context.Context, now time.Time) ([]MemoryDocument, error)

	// SoftDelete marks (agentID, scope, memoryID) as deleted by setting
	// deleted_at to now. The file on disk is preserved for audit purposes.
	// Soft-deleted records are excluded from FindOne and FindActive results.
	SoftDelete(ctx context.Context, agentID, scope, memoryID string) error

	// EnsureIndexes creates the required MongoDB indexes (idempotent).
	EnsureIndexes(ctx context.Context) error
}

// ── Args / Results ────────────────────────────────────────────────────────────

type MemoryWriteArgs struct {
	Content    string  `json:"content"`
	Type       string  `json:"type"`
	Scope      string  `json:"scope"`
	Importance float64 `json:"importance"`
	TTLDays    *int    `json:"ttl_days,omitempty"`
}

type MemorySearchArgs struct {
	Pattern string  `json:"pattern"`
	Scope   string  `json:"scope"`
	Type    *string `json:"type,omitempty"`
	Limit   *int    `json:"limit,omitempty"`
}

type MemoryReadArgs struct {
	MemoryID string `json:"memory_id"`
	Scope    string `json:"scope"`
}

type WriteResult struct {
	MemoryID  string  `json:"memory_id"`
	Scope     string  `json:"scope"`
	CreatedAt string  `json:"created_at"`
	ExpiresAt *string `json:"expires_at,omitempty"`
}

type SearchResult struct {
	MemoryID   string  `json:"memory_id"`
	Snippet    string  `json:"snippet"`
	Type       string  `json:"type"`
	Scope      string  `json:"scope"`
	Importance float64 `json:"importance"`
	CreatedAt  string  `json:"created_at"`
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
	CreatedAt  string  `json:"created_at"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
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
