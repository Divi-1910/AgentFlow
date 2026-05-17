package memory

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"backend/runtimectx"
)

// Service is the application-layer entry point for all memory operations.
// It coordinates between the filesystem (content) and MetaStore (metadata).
type Service struct {
	cfg  Config
	meta MetaStore
}

func NewService(cfg Config, meta MetaStore) *Service {
	return &Service{cfg: cfg.withDefaults(), meta: meta}
}

func NewServiceFromEnv(meta MetaStore) (*Service, error) {
	root := strings.TrimSpace(os.Getenv("MEMORY_ROOT"))
	if root == "" {
		root = filepath.Join(os.TempDir(), "agentflow-memory")
		slog.Info("MEMORY_ROOT not set", "default", root)
	}
	svc := NewService(Config{
		Root:   root,
		RGPath: os.Getenv("RG_PATH"),
	}, meta)
	if err := svc.ValidateStartup(); err != nil {
		return nil, err
	}
	return svc, nil
}

func (s *Service) ValidateStartup() error {
	if strings.TrimSpace(s.cfg.Root) == "" {
		return fmt.Errorf("memory: root is required")
	}
	if err := EnsureDir(s.cfg.Root); err != nil {
		return err
	}
	rootInfo, err := os.Stat(s.cfg.Root)
	if err != nil {
		return fmt.Errorf("memory: stat root: %w", err)
	}
	if !rootInfo.IsDir() {
		return fmt.Errorf("memory: root is not a directory: %s", s.cfg.Root)
	}
	if _, err := exec.LookPath(s.cfg.RGPath); err != nil {
		return fmt.Errorf("memory: rg not found: %w", err)
	}
	return nil
}

// Write creates or overwrites a memory document.
//
// For new memories: writes freely.
// For existing, non-expired memories: requires that the agent called
// memory_read within the configured ReadWindowDuration; returns
// ErrReadBeforeWrite otherwise.
//
// Write order: file first, MongoDB second. If the MongoDB upsert fails,
// a best-effort rollback removes the file to keep the two stores consistent.
func (s *Service) Write(ctx context.Context, execScope runtimectx.MemoryScope, memoryID string, args MemoryWriteArgs) (*WriteResult, error) {
	if err := validateExecutionScope(execScope); err != nil {
		return nil, err
	}
	if !validType(args.Type) {
		return nil, ErrInvalidType
	}
	if !validScope(args.Scope) {
		return nil, ErrInvalidScope
	}
	if err := validateSegment("memory_id", memoryID); err != nil {
		return nil, err
	}

	body := strings.TrimSpace(args.Content)
	if body == "" {
		return nil, fmt.Errorf("%w: content is required", ErrInvalidDocument)
	}
	if len(body) > s.cfg.MaxBodyBytes {
		return nil, fmt.Errorf("%w: content exceeds max body size", ErrInvalidDocument)
	}

	importance := clampImportance(args.Importance)

	path, err := ResolveWritePath(s.cfg.Root, execScope, args.Scope, memoryID)
	if err != nil {
		return nil, err
	}

	// ── Read-before-write guardrail ───────────────────────────────────────────
	now := time.Now().UTC()
	existing, err := s.meta.FindOne(ctx, execScope.AgentID, args.Scope, memoryID)
	if err != nil {
		return nil, fmt.Errorf("memory: meta lookup: %w", err)
	}
	if existing != nil && !isExpired(*existing, now) {
		if existing.LastReadAt == nil || now.Sub(*existing.LastReadAt) > s.cfg.ReadWindowDuration {
			return nil, ErrReadBeforeWrite
		}
	}

	// ── Build document ────────────────────────────────────────────────────────
	var expiresAt *time.Time
	if args.TTLDays != nil {
		if *args.TTLDays <= 0 {
			return nil, fmt.Errorf("%w: ttl_days must be positive", ErrInvalidDocument)
		}
		expires := now.Add(time.Duration(*args.TTLDays) * 24 * time.Hour)
		expiresAt = &expires
	}

	// Preserve the original creation timestamp for active overwrites.
	createdAt := now
	if existing != nil && !isExpired(*existing, now) {
		createdAt = existing.CreatedAt
	}

	doc := MemoryDocument{
		UserID:     execScope.UserID,
		AgentID:    execScope.AgentID,
		ThreadID:   execScope.ThreadID,
		ID:         memoryID,
		Type:       args.Type,
		Scope:      args.Scope,
		Importance: importance,
		CreatedAt:  createdAt,
		ExpiresAt:  expiresAt,
		Body:       body,
	}

	// ── Persist: file first, MongoDB second ───────────────────────────────────
	if err := WriteFileAtomic(path, body); err != nil {
		return nil, err
	}

	if err := s.meta.Upsert(ctx, doc); err != nil {
		// Rollback: remove the file we just wrote so the stores stay consistent.
		if removeErr := os.Remove(path); removeErr != nil {
			slog.Warn("memory: rollback failed — orphaned file may remain",
				"path", path, "remove_error", removeErr)
		}
		return nil, fmt.Errorf("memory: meta upsert: %w", err)
	}

	var expiresRaw *string
	if expiresAt != nil {
		v := expiresAt.UTC().Format(time.RFC3339)
		expiresRaw = &v
	}
	return &WriteResult{
		MemoryID:  memoryID,
		Scope:     args.Scope,
		CreatedAt: createdAt.Format(time.RFC3339),
		ExpiresAt: expiresRaw,
	}, nil
}

// Read fetches a memory document's metadata from MongoDB and its content from
// disk. On success it stamps last_read_at in MongoDB (best-effort: a stamp
// failure is logged but never surfaces to the caller).
func (s *Service) Read(ctx context.Context, execScope runtimectx.MemoryScope, args MemoryReadArgs) (*ReadResult, error) {
	if err := validateExecutionScope(execScope); err != nil {
		return nil, err
	}
	if !validScope(args.Scope) {
		return nil, ErrInvalidScope
	}
	if err := validateSegment("memory_id", args.MemoryID); err != nil {
		return nil, err
	}

	doc, err := s.meta.FindOne(ctx, execScope.AgentID, args.Scope, args.MemoryID)
	if err != nil {
		return nil, fmt.Errorf("memory: meta lookup: %w", err)
	}
	if doc == nil {
		return nil, ErrMemoryNotFound
	}
	if isExpired(*doc, time.Now().UTC()) {
		return nil, ErrExpiredMemory
	}

	path, err := ResolveReadPath(s.cfg.Root, execScope, args.Scope, args.MemoryID)
	if err != nil {
		return nil, err
	}
	data, err := ReadFileLimited(path, s.cfg.MaxFileBytes)
	if err != nil {
		return nil, err
	}
	doc.Body = strings.TrimSpace(string(data))

	// Stamp last_read_at — enables subsequent writes within the window.
	if stampErr := s.meta.StampRead(ctx, execScope.AgentID, args.Scope, args.MemoryID); stampErr != nil {
		slog.Warn("memory: failed to stamp last_read_at", "error", stampErr,
			"agent_id", execScope.AgentID, "scope", args.Scope, "memory_id", args.MemoryID)
	}

	return toReadResult(*doc), nil
}

// Search finds memory documents whose body content matches the ripgrep pattern.
// Candidate documents are fetched from MongoDB (scope-filtered, expiry-filtered);
// only the files of those candidates are given to ripgrep.
func (s *Service) Search(ctx context.Context, execScope runtimectx.MemoryScope, args MemorySearchArgs) (*SearchResponse, error) {
	if err := validateExecutionScope(execScope); err != nil {
		return nil, err
	}
	if !validScope(args.Scope) {
		return nil, ErrInvalidScope
	}
	pattern := strings.TrimSpace(args.Pattern)
	if pattern == "" {
		return nil, fmt.Errorf("%w: pattern is required", ErrInvalidDocument)
	}
	if args.Type != nil && !validType(*args.Type) {
		return nil, ErrInvalidType
	}

	limit := DefaultSearchLimit
	if args.Limit != nil {
		limit = *args.Limit
	}
	if limit <= 0 {
		limit = DefaultSearchLimit
	}
	if limit > MaxSearchLimit {
		limit = MaxSearchLimit
	}

	docs, err := s.meta.FindActive(ctx, execScope, args.Scope, args.Type, time.Now().UTC())
	if err != nil {
		return nil, fmt.Errorf("memory: find active: %w", err)
	}
	if len(docs) == 0 {
		return &SearchResponse{Results: []SearchResult{}}, nil
	}

	// Derive filesystem paths and build a path → doc index.
	files := make([]string, 0, len(docs))
	byPath := make(map[string]MemoryDocument, len(docs))
	for _, doc := range docs {
		p, pathErr := ResolveWritePath(s.cfg.Root, runtimectx.MemoryScope{
			UserID:   doc.UserID,
			AgentID:  doc.AgentID,
			ThreadID: doc.ThreadID,
		}, doc.Scope, doc.ID)
		if pathErr != nil {
			continue
		}
		files = append(files, p)
		byPath[p] = doc
	}

	searchCtx, cancel := context.WithTimeout(ctx, s.cfg.SearchTimeout)
	defer cancel()

	hits, err := SearchCandidates(searchCtx, s.cfg.RGPath, pattern, files)
	if err != nil {
		return nil, err
	}
	if len(hits) == 0 {
		return &SearchResponse{Results: []SearchResult{}}, nil
	}

	results := make([]SearchResult, 0, len(hits))
	for p, lineNumber := range hits {
		doc, ok := byPath[p]
		if !ok {
			continue
		}
		snippet := ""
		if data, readErr := ReadFileLimited(p, s.cfg.MaxFileBytes); readErr == nil {
			snippet = snippetAroundLine(strings.TrimSpace(string(data)), lineNumber)
		}
		results = append(results, SearchResult{
			MemoryID:   doc.ID,
			Snippet:    snippet,
			Type:       doc.Type,
			Scope:      doc.Scope,
			Importance: doc.Importance,
			CreatedAt:  doc.CreatedAt.UTC().Format(time.RFC3339),
		})
	}

	sort.Slice(results, func(i, j int) bool {
		if results[i].Importance != results[j].Importance {
			return results[i].Importance > results[j].Importance
		}
		if results[i].CreatedAt != results[j].CreatedAt {
			return results[i].CreatedAt > results[j].CreatedAt
		}
		return results[i].MemoryID < results[j].MemoryID
	})

	if len(results) > limit {
		results = results[:limit]
	}
	return &SearchResponse{Results: results}, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func isExpired(doc MemoryDocument, now time.Time) bool {
	return doc.ExpiresAt != nil && !doc.ExpiresAt.After(now)
}

func clampImportance(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// snippetAroundLine returns a short excerpt of body centred on absoluteLine.
// Lines are 1-indexed; files contain no frontmatter so no offset is needed.
func snippetAroundLine(body string, absoluteLine int) string {
	lines := strings.Split(body, "\n")
	relativeLine := absoluteLine - 1 // convert to 0-indexed
	if relativeLine < 0 || relativeLine >= len(lines) {
		if len(body) <= 160 {
			return body
		}
		return body[:160] + "..."
	}

	start := relativeLine - 1
	if start < 0 {
		start = 0
	}
	end := relativeLine + 2
	if end > len(lines) {
		end = len(lines)
	}

	snippet := strings.Join(lines[start:end], "\n")
	if start > 0 {
		snippet = "...\n" + snippet
	}
	if end < len(lines) {
		snippet += "\n..."
	}
	return snippet
}

func toReadResult(doc MemoryDocument) *ReadResult {
	var expiresAt *string
	if doc.ExpiresAt != nil {
		v := doc.ExpiresAt.UTC().Format(time.RFC3339)
		expiresAt = &v
	}
	return &ReadResult{
		MemoryID:   doc.ID,
		Content:    doc.Body,
		Type:       doc.Type,
		Scope:      doc.Scope,
		AgentID:    doc.AgentID,
		ThreadID:   doc.ThreadID,
		Importance: doc.Importance,
		CreatedAt:  doc.CreatedAt.UTC().Format(time.RFC3339),
		ExpiresAt:  expiresAt,
	}
}
