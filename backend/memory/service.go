package memory

import (
	"context"
	"errors"
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

type Service struct {
	cfg Config
}

type candidate struct {
	Path string
	Doc  MemoryDocument
	Size int64
}

func NewService(cfg Config) *Service {
	return &Service{cfg: cfg.withDefaults()}
}

func NewServiceFromEnv() (*Service, error) {
	root := strings.TrimSpace(os.Getenv("MEMORY_ROOT"))
	if root == "" {
		root = filepath.Join(os.TempDir(), "agentflow-memory")
		slog.Info("MEMORY_ROOT not set", "default", root)
	}
	svc := NewService(Config{
		Root:   root,
		RGPath: os.Getenv("RG_PATH"),
	})
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

func (s *Service) Write(_ context.Context, execScope runtimectx.MemoryScope, memoryID string, args MemoryWriteArgs) (*WriteResult, error) {
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

	importance := args.Importance
	if importance < 0 {
		importance = 0
	}
	if importance > 1 {
		importance = 1
	}

	path, err := ResolveWritePath(s.cfg.Root, execScope, args.Scope, memoryID)
	if err != nil {
		return nil, err
	}

	if existing, readErr := s.readDocument(path); readErr == nil && !isExpired(existing, time.Now().UTC()) {
		var expiresRaw *string
		if existing.ExpiresAt != nil {
			value := existing.ExpiresAt.UTC().Format(time.RFC3339)
			expiresRaw = &value
		}
		return &WriteResult{
			MemoryID:  existing.ID,
			Scope:     existing.Scope,
			CreatedAt: existing.CreatedAt.UTC().Format(time.RFC3339),
			ExpiresAt: expiresRaw,
		}, nil
	}

	now := time.Now().UTC()
	var expiresAt *time.Time
	if args.TTLDays != nil {
		if *args.TTLDays <= 0 {
			return nil, fmt.Errorf("%w: ttl_days must be positive", ErrInvalidDocument)
		}
		expires := now.Add(time.Duration(*args.TTLDays) * 24 * time.Hour)
		expiresAt = &expires
	}

	doc := MemoryDocument{
		Version:    DocumentVersion,
		ID:         memoryID,
		Type:       args.Type,
		Scope:      args.Scope,
		AgentID:    execScope.AgentID,
		ThreadID:   execScope.ThreadID,
		Importance: importance,
		CreatedAt:  now,
		ExpiresAt:  expiresAt,
		Body:       body,
	}

	rendered, err := Render(doc)
	if err != nil {
		return nil, err
	}
	if len(rendered) > s.cfg.MaxFileBytes {
		return nil, fmt.Errorf("%w: rendered document exceeds max file size", ErrInvalidDocument)
	}
	if err := WriteFileAtomic(path, rendered); err != nil {
		return nil, err
	}

	var expiresRaw *string
	if expiresAt != nil {
		value := expiresAt.UTC().Format(time.RFC3339)
		expiresRaw = &value
	}

	return &WriteResult{
		MemoryID:  memoryID,
		Scope:     args.Scope,
		CreatedAt: now.Format(time.RFC3339),
		ExpiresAt: expiresRaw,
	}, nil
}

func (s *Service) Read(_ context.Context, execScope runtimectx.MemoryScope, args MemoryReadArgs) (*ReadResult, error) {
	if err := validateExecutionScope(execScope); err != nil {
		return nil, err
	}
	if !validScope(args.Scope) {
		return nil, ErrInvalidScope
	}
	if err := validateSegment("memory_id", args.MemoryID); err != nil {
		return nil, err
	}

	path, err := ResolveReadPath(s.cfg.Root, execScope, args.Scope, args.MemoryID)
	if err != nil {
		return nil, err
	}

	doc, err := s.readDocument(path)
	if err != nil {
		return nil, err
	}
	if err := ValidateDocumentPath(s.cfg.Root, path, doc); err != nil {
		return nil, err
	}
	if isExpired(doc, time.Now().UTC()) {
		return nil, ErrExpiredMemory
	}

	return toReadResult(doc), nil
}

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

	roots, err := ResolveSearchRoots(s.cfg.Root, execScope, args.Scope)
	if err != nil {
		return nil, err
	}

	candidates, err := s.collectCandidates(roots, args.Type)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return &SearchResponse{Results: []SearchResult{}}, nil
	}

	searchCtx, cancel := context.WithTimeout(ctx, s.cfg.SearchTimeout)
	defer cancel()

	files := make([]string, 0, len(candidates))
	bodyStartLines := make(map[string]int, len(candidates))
	byPath := make(map[string]candidate, len(candidates))
	for _, cand := range candidates {
		files = append(files, cand.Path)
		bodyStartLines[cand.Path] = cand.Doc.BodyStartLine
		byPath[cand.Path] = cand
	}

	hits, err := SearchCandidates(searchCtx, s.cfg.RGPath, pattern, files, bodyStartLines)
	if err != nil {
		return nil, err
	}
	if len(hits) == 0 {
		return &SearchResponse{Results: []SearchResult{}}, nil
	}

	results := make([]SearchResult, 0, len(hits))
	for path, lineNumber := range hits {
		cand := byPath[path]
		results = append(results, SearchResult{
			MemoryID:   cand.Doc.ID,
			Snippet:    snippetAroundLine(cand.Doc, lineNumber),
			Type:       cand.Doc.Type,
			Scope:      cand.Doc.Scope,
			Importance: cand.Doc.Importance,
			CreatedAt:  cand.Doc.CreatedAt.UTC().Format(time.RFC3339),
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

func (s *Service) collectCandidates(roots []string, typeFilter *string) ([]candidate, error) {
	now := time.Now().UTC()
	candidates := make([]candidate, 0)
	totalBytes := int64(0)

	for _, root := range roots {
		files, err := ListMarkdownFiles(root)
		if err != nil {
			return nil, err
		}
		for _, path := range files {
			if len(candidates) >= MaxScannedFiles {
				return nil, ErrSearchBudgetExceeded
			}
			info, err := os.Stat(path)
			if err != nil {
				return nil, fmt.Errorf("memory: stat candidate: %w", err)
			}
			totalBytes += info.Size()
			if totalBytes > MaxScannedBytes {
				return nil, ErrSearchBudgetExceeded
			}

			doc, err := s.readDocument(path)
			if err != nil {
				if errors.Is(err, ErrInvalidDocument) {
					continue
				}
				return nil, err
			}
			if err := ValidateDocumentPath(s.cfg.Root, path, doc); err != nil {
				continue
			}
			if isExpired(doc, now) {
				continue
			}
			if typeFilter != nil && doc.Type != *typeFilter {
				continue
			}

			candidates = append(candidates, candidate{
				Path: path,
				Doc:  doc,
				Size: info.Size(),
			})
		}
	}

	return candidates, nil
}

func (s *Service) readDocument(path string) (MemoryDocument, error) {
	data, err := ReadFileLimited(path, s.cfg.MaxFileBytes)
	if err != nil {
		if errors.Is(err, ErrMemoryNotFound) {
			return MemoryDocument{}, ErrMemoryNotFound
		}
		if errors.Is(err, ErrInvalidDocument) {
			return MemoryDocument{}, ErrInvalidDocument
		}
		return MemoryDocument{}, err
	}
	doc, err := Parse(data)
	if err != nil {
		return MemoryDocument{}, err
	}
	return doc, nil
}

func isExpired(doc MemoryDocument, now time.Time) bool {
	return doc.ExpiresAt != nil && !doc.ExpiresAt.After(now)
}

func snippetAroundLine(doc MemoryDocument, absoluteLine int) string {
	lines := strings.Split(doc.Body, "\n")
	relativeLine := absoluteLine - doc.BodyStartLine
	if relativeLine < 0 || relativeLine >= len(lines) {
		if len(doc.Body) <= 160 {
			return doc.Body
		}
		return doc.Body[:160] + "..."
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
		value := doc.ExpiresAt.UTC().Format(time.RFC3339)
		expiresAt = &value
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
