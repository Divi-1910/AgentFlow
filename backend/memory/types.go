package memory

import (
	"errors"
	"time"
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
	DefaultSearchLimit  = 5
	MaxSearchLimit      = 20
	DefaultMaxBodyBytes = 8 * 1024
	DefaultMaxFileBytes = 12 * 1024
	MaxScannedFiles     = 500
	MaxScannedBytes     = 8 * 1024 * 1024
	DefaultSearchTimeout = 5 * time.Second
)

var (
	ErrInvalidScope        = errors.New("invalid memory scope")
	ErrInvalidType         = errors.New("invalid memory type")
	ErrInvalidDocument     = errors.New("invalid memory document")
	ErrExpiredMemory       = errors.New("memory expired")
	ErrMemoryNotFound      = errors.New("memory not found")
	ErrSearchBudgetExceeded = errors.New("memory search budget exceeded")
)

type Config struct {
	Root          string
	RGPath        string
	MaxBodyBytes  int
	MaxFileBytes  int
	SearchTimeout time.Duration
}

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

type MemoryDocument struct {
	Version       int
	ID            string
	Type          string
	Scope         string
	AgentID       string
	ThreadID      string
	Importance    float64
	CreatedAt     time.Time
	ExpiresAt     *time.Time
	Body          string
	BodyStartLine int
}

type WriteResult struct {
	MemoryID  string  `json:"memory_id"`
	Scope     string  `json:"scope"`
	CreatedAt string  `json:"created_at"`
	ExpiresAt *string `json:"expires_at"`
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
	ExpiresAt  *string `json:"expires_at"`
}

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
	return c
}

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
