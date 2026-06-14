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

type Service struct {
	cfg       Config
	meta      MetaStore
	revisions RevisionStore
}

func NewService(cfg Config, meta MetaStore, revisions ...RevisionStore) *Service {
	var revStore RevisionStore
	if len(revisions) > 0 {
		revStore = revisions[0]
	}
	if revStore == nil {
		revStore = NewInMemoryRevisionStore()
	}
	return &Service{cfg: cfg.withDefaults(), meta: meta, revisions: revStore}
}

func NewServiceFromEnv(meta MetaStore, revisions RevisionStore) (*Service, error) {
	root := strings.TrimSpace(os.Getenv("MEMORY_ROOT"))
	if root == "" {
		root = filepath.Join(os.TempDir(), "agentflow-memory")
		slog.Info("MEMORY_ROOT not set", "default", root)
	}
	svc := NewService(Config{
		Root:   root,
		RGPath: os.Getenv("RG_PATH"),
	}, meta, revisions)
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
	mutationID, err := MutationID(args.RunID, args.ToolCallID)
	if err != nil {
		return nil, err
	}
	memoryID = strings.TrimSpace(memoryID)
	if memoryID == "" {
		memoryID, err = DerivedMemoryID(args.RunID, args.ToolCallID)
		if err != nil {
			return nil, err
		}
	}
	if err := validateSegment("memory_id", memoryID); err != nil {
		return nil, err
	}
	lineageKey, err := LineageKey(execScope, args.Scope, memoryID)
	if err != nil {
		return nil, err
	}
	if replay, err := s.replayCreate(ctx, lineageKey, mutationID); replay != nil || err != nil {
		if err != nil {
			return nil, err
		}
		return writeResultFromRevision(*replay), nil
	}

	body := strings.TrimSpace(args.Content)
	if err := validateBody(body, s.cfg.MaxBodyBytes); err != nil {
		return nil, err
	}

	if latest, err := s.revisions.Latest(ctx, lineageKey); err != nil {
		return nil, fmt.Errorf("memory: latest revision: %w", err)
	} else if latest != nil {
		s.bestEffortProject(ctx, lineageKey)
		return nil, createCollisionError(*latest)
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

	rev := MemoryRevision{
		LineageKey: lineageKey,
		Revision:   1,
		MutationID: mutationID,
		RunID:      args.RunID,
		ToolCallID: args.ToolCallID,
		Operation:  OperationCreate,
		UserID:     execScope.UserID,
		AgentID:    execScope.AgentID,
		ThreadID:   execScope.ThreadID,
		MemoryID:   memoryID,
		Scope:      args.Scope,
		Type:       args.Type,
		Importance: clampImportance(args.Importance),
		CreatedAt:  now,
		UpdatedAt:  now,
		ExpiresAt:  expiresAt,
	}
	appended, _, err := s.commitRevision(ctx, rev, body)
	if err != nil {
		return nil, err
	}
	s.bestEffortProject(ctx, lineageKey)
	return writeResultFromRevision(*appended), nil
}

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
	lineageKey, err := LineageKey(execScope, args.Scope, args.MemoryID)
	if err != nil {
		return nil, err
	}
	s.bestEffortProject(ctx, lineageKey)

	var rev *MemoryRevision
	if args.Revision != nil {
		if *args.Revision <= 0 {
			return nil, fmt.Errorf("%w: revision must be positive", ErrInvalidDocument)
		}
		rev, err = s.revisions.FindRevision(ctx, lineageKey, *args.Revision)
	} else {
		rev, err = s.revisions.Latest(ctx, lineageKey)
	}
	if err != nil {
		return nil, fmt.Errorf("memory: read revision: %w", err)
	}
	if rev == nil {
		return nil, ErrMemoryNotFound
	}

	if args.Revision == nil {
		now := time.Now().UTC()
		if rev.RetiredAt != nil {
			return nil, ErrRetiredMemory
		}
		if isExpiredRevision(*rev, now) {
			return nil, ErrExpiredMemory
		}
	}

	body, err := ReadRevisionBody(s.cfg.Root, *rev, s.cfg.MaxFileBytes)
	if err != nil {
		return nil, err
	}
	doc := documentFromRevision(*rev, strings.TrimSpace(body))

	if args.Revision == nil && s.meta != nil {
		if stampErr := s.meta.StampRead(ctx, doc); stampErr != nil {
			slog.Warn("memory: failed to stamp last_read_at", "error", stampErr,
				"lineage_key", doc.LineageKey, "memory_id", doc.ID)
		}
	}
	return toReadResult(doc), nil
}

func (s *Service) ReadByMeta(_ context.Context, doc MemoryDocument) (string, error) {
	path, err := documentBodyPath(s.cfg.Root, doc)
	if err != nil {
		return "", err
	}
	data, err := ReadFileLimited(path, s.cfg.MaxFileBytes)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
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

	docs, err := s.meta.FindActive(ctx, execScope, args.Scope, args.Type, args.IncludeRetired, time.Now().UTC())
	if err != nil {
		return nil, fmt.Errorf("memory: find active: %w", err)
	}
	if len(docs) == 0 {
		return &SearchResponse{Results: []SearchResult{}}, nil
	}

	files := make([]string, 0, len(docs))
	seenFiles := make(map[string]bool, len(docs))
	byPath := make(map[string][]MemoryDocument, len(docs))
	for _, doc := range docs {
		p, err := documentBodyPath(s.cfg.Root, doc)
		if err != nil {
			return nil, err
		}
		if !seenFiles[p] {
			files = append(files, p)
			seenFiles[p] = true
		}
		byPath[p] = append(byPath[p], doc)
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
		docsForPath := byPath[p]
		if len(docsForPath) == 0 {
			continue
		}
		snippet := ""
		if data, readErr := ReadFileLimited(p, s.cfg.MaxFileBytes); readErr == nil {
			snippet = snippetAroundLine(strings.TrimSpace(string(data)), lineNumber)
		}
		for _, doc := range docsForPath {
			results = append(results, SearchResult{
				MemoryID:   doc.ID,
				Snippet:    snippet,
				Type:       doc.Type,
				Scope:      doc.Scope,
				Importance: doc.Importance,
				Revision:   doc.Revision,
				Retired:    doc.RetiredAt != nil,
				CreatedAt:  doc.CreatedAt.UTC().Format(time.RFC3339),
				UpdatedAt:  doc.UpdatedAt.UTC().Format(time.RFC3339),
			})
		}
	}

	sort.Slice(results, func(i, j int) bool {
		if results[i].Importance != results[j].Importance {
			return results[i].Importance > results[j].Importance
		}
		if results[i].UpdatedAt != results[j].UpdatedAt {
			return results[i].UpdatedAt > results[j].UpdatedAt
		}
		return results[i].MemoryID < results[j].MemoryID
	})

	if len(results) > limit {
		results = results[:limit]
	}
	return &SearchResponse{Results: results}, nil
}

func (s *Service) Patch(ctx context.Context, execScope runtimectx.MemoryScope, args MemoryPatchArgs) (*MutationResult, error) {
	return s.mutateActive(ctx, execScope, args.MemoryID, args.Scope, args.ExpectedRevision, args.Reason, args.RunID, args.ToolCallID, OperationPatch, func(latest MemoryRevision, currentBody string, now time.Time) (MemoryRevision, string, error) {
		body, err := applyPatchEdits(currentBody, args.Edits, s.cfg.MaxBodyBytes)
		if err != nil {
			return MemoryRevision{}, "", err
		}
		rev := nextRevisionFrom(latest, now, OperationPatch, args.Reason)
		return rev, body, nil
	})
}

func (s *Service) Update(ctx context.Context, execScope runtimectx.MemoryScope, args MemoryUpdateArgs) (*MutationResult, error) {
	return s.mutateActive(ctx, execScope, args.MemoryID, args.Scope, args.ExpectedRevision, args.Reason, args.RunID, args.ToolCallID, OperationUpdate, func(latest MemoryRevision, _ string, now time.Time) (MemoryRevision, string, error) {
		body := strings.TrimSpace(args.Content)
		if err := validateBody(body, s.cfg.MaxBodyBytes); err != nil {
			return MemoryRevision{}, "", err
		}
		rev := nextRevisionFrom(latest, now, OperationUpdate, args.Reason)
		return rev, body, nil
	})
}

func (s *Service) Retire(ctx context.Context, execScope runtimectx.MemoryScope, args MemoryRetireArgs) (*MutationResult, error) {
	return s.mutateActive(ctx, execScope, args.MemoryID, args.Scope, args.ExpectedRevision, args.Reason, args.RunID, args.ToolCallID, OperationRetire, func(latest MemoryRevision, currentBody string, now time.Time) (MemoryRevision, string, error) {
		rev := nextRevisionFrom(latest, now, OperationRetire, args.Reason)
		rev.RetiredAt = &now
		return rev, strings.TrimSpace(currentBody), nil
	})
}

func (s *Service) Restore(ctx context.Context, execScope runtimectx.MemoryScope, args MemoryRestoreArgs) (*MutationResult, error) {
	if err := validateMutationInput(execScope, args.MemoryID, args.Scope, args.ExpectedRevision, args.Reason); err != nil {
		return nil, err
	}
	mutationID, err := MutationID(args.RunID, args.ToolCallID)
	if err != nil {
		return nil, err
	}
	lineageKey, err := LineageKey(execScope, args.Scope, args.MemoryID)
	if err != nil {
		return nil, err
	}
	if replay, err := s.replayMutation(ctx, lineageKey, mutationID); replay != nil || err != nil {
		if err != nil {
			return nil, err
		}
		return mutationResultFromRevision(*replay), nil
	}

	latest, err := s.revisions.Latest(ctx, lineageKey)
	if err != nil {
		return nil, fmt.Errorf("memory: latest revision: %w", err)
	}
	if latest == nil {
		return nil, ErrMemoryNotFound
	}
	s.bestEffortProject(ctx, lineageKey)
	if latest.Revision != *args.ExpectedRevision {
		return nil, ErrRevisionConflict
	}

	var from *MemoryRevision
	if args.FromRevision != nil {
		if *args.FromRevision <= 0 {
			return nil, fmt.Errorf("%w: from_revision must be positive", ErrInvalidDocument)
		}
		from, err = s.revisions.FindRevision(ctx, lineageKey, *args.FromRevision)
		if err != nil {
			return nil, fmt.Errorf("memory: restore source: %w", err)
		}
	} else {
		if latest.RetiredAt == nil {
			return nil, fmt.Errorf("%w: from_revision is required when latest revision is active", ErrInvalidDocument)
		}
		from, err = s.latestNonRetired(ctx, lineageKey)
		if err != nil {
			return nil, err
		}
	}
	if from == nil {
		return nil, ErrMemoryNotFound
	}
	if isExpiredRevision(*from, time.Now().UTC()) {
		return nil, ErrExpiredMemory
	}
	body, err := ReadRevisionBody(s.cfg.Root, *from, s.cfg.MaxFileBytes)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	rev := nextRevisionFrom(*latest, now, OperationRestore, args.Reason)
	rev.RunID = args.RunID
	rev.ToolCallID = args.ToolCallID
	rev.MutationID = mutationID
	rev.RestoredFrom = &from.Revision
	rev.Type = from.Type
	rev.Importance = from.Importance
	rev.ExpiresAt = from.ExpiresAt
	rev.RetiredAt = nil
	appended, _, err := s.commitRevision(ctx, rev, strings.TrimSpace(body))
	if err != nil {
		return nil, err
	}
	s.bestEffortProject(ctx, lineageKey)
	return mutationResultFromRevision(*appended), nil
}

func (s *Service) History(ctx context.Context, execScope runtimectx.MemoryScope, args MemoryHistoryArgs) (*HistoryResponse, error) {
	if err := validateExecutionScope(execScope); err != nil {
		return nil, err
	}
	if !validScope(args.Scope) {
		return nil, ErrInvalidScope
	}
	if err := validateSegment("memory_id", args.MemoryID); err != nil {
		return nil, err
	}
	lineageKey, err := LineageKey(execScope, args.Scope, args.MemoryID)
	if err != nil {
		return nil, err
	}
	s.bestEffortProject(ctx, lineageKey)
	revs, err := s.revisions.List(ctx, lineageKey)
	if err != nil {
		return nil, fmt.Errorf("memory: history: %w", err)
	}
	if len(revs) == 0 {
		return nil, ErrMemoryNotFound
	}
	sort.Slice(revs, func(i, j int) bool { return revs[i].Revision < revs[j].Revision })
	out := make([]HistoryRevision, 0, len(revs))
	for _, rev := range revs {
		out = append(out, historyRevisionFromRevision(rev))
	}
	return &HistoryResponse{MemoryID: args.MemoryID, Scope: args.Scope, Revisions: out}, nil
}

func (s *Service) mutateActive(
	ctx context.Context,
	execScope runtimectx.MemoryScope,
	memoryID string,
	scope string,
	expectedRevision *int,
	reason string,
	runID string,
	toolCallID string,
	op string,
	build func(latest MemoryRevision, currentBody string, now time.Time) (MemoryRevision, string, error),
) (*MutationResult, error) {
	if err := validateMutationInput(execScope, memoryID, scope, expectedRevision, reason); err != nil {
		return nil, err
	}
	mutationID, err := MutationID(runID, toolCallID)
	if err != nil {
		return nil, err
	}
	lineageKey, err := LineageKey(execScope, scope, memoryID)
	if err != nil {
		return nil, err
	}
	if replay, err := s.replayMutation(ctx, lineageKey, mutationID); replay != nil || err != nil {
		if err != nil {
			return nil, err
		}
		return mutationResultFromRevision(*replay), nil
	}

	latest, err := s.revisions.Latest(ctx, lineageKey)
	if err != nil {
		return nil, fmt.Errorf("memory: latest revision: %w", err)
	}
	if latest == nil {
		return nil, ErrMemoryNotFound
	}
	s.bestEffortProject(ctx, lineageKey)
	if latest.Revision != *expectedRevision {
		return nil, ErrRevisionConflict
	}
	if latest.RetiredAt != nil {
		return nil, ErrRetiredMemory
	}
	if isExpiredRevision(*latest, time.Now().UTC()) {
		return nil, ErrExpiredMemory
	}

	currentBody, err := ReadRevisionBody(s.cfg.Root, *latest, s.cfg.MaxFileBytes)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	next, nextBody, err := build(*latest, currentBody, now)
	if err != nil {
		return nil, err
	}
	next.MutationID = mutationID
	next.RunID = runID
	next.ToolCallID = toolCallID
	appended, _, err := s.commitRevision(ctx, next, nextBody)
	if err != nil {
		return nil, err
	}
	s.bestEffortProject(ctx, lineageKey)
	return mutationResultFromRevision(*appended), nil
}

func (s *Service) replayCreate(ctx context.Context, lineageKey, mutationID string) (*MemoryRevision, error) {
	return s.replayMutation(ctx, lineageKey, mutationID)
}

func (s *Service) replayMutation(ctx context.Context, lineageKey, mutationID string) (*MemoryRevision, error) {
	existing, err := s.revisions.FindByMutation(ctx, mutationID)
	if err != nil {
		return nil, fmt.Errorf("memory: mutation lookup: %w", err)
	}
	if existing == nil {
		return nil, nil
	}
	if existing.LineageKey != lineageKey {
		return nil, ErrRevisionConflict
	}
	if err := FinalizeRevisionBody(s.cfg.Root, *existing); err != nil {
		return nil, err
	}
	s.bestEffortProject(ctx, lineageKey)
	return existing, nil
}

func (s *Service) commitRevision(ctx context.Context, rev MemoryRevision, body string) (*MemoryRevision, bool, error) {
	bodyPath, err := RevisionBodyRelPath(rev)
	if err != nil {
		return nil, false, err
	}
	rev.BodyPath = bodyPath
	if err := WritePendingRevisionBody(s.cfg.Root, rev, body); err != nil {
		return nil, false, err
	}
	appended, replayed, err := s.revisions.Append(ctx, rev)
	if err != nil {
		removePendingRevisionBody(s.cfg.Root, rev)
		return nil, false, err
	}
	if err := FinalizeRevisionBody(s.cfg.Root, *appended); err != nil {
		return nil, replayed, err
	}
	return appended, replayed, nil
}

func (s *Service) bestEffortProject(ctx context.Context, lineageKey string) {
	if s.meta == nil {
		return
	}
	latest, err := s.revisions.Latest(ctx, lineageKey)
	if err != nil || latest == nil {
		if err != nil {
			slog.Warn("memory: project latest lookup failed", "lineage_key", lineageKey, "error", err)
		}
		return
	}
	body, readErr := ReadRevisionBody(s.cfg.Root, *latest, s.cfg.MaxFileBytes)
	if readErr != nil {
		slog.Warn("memory: project latest body read failed", "lineage_key", lineageKey, "revision", latest.Revision, "body_path", latest.BodyPath, "error", readErr)
	}
	if err := s.meta.Upsert(ctx, documentFromRevision(*latest, strings.TrimSpace(body))); err != nil {
		slog.Warn("memory: project latest failed", "lineage_key", lineageKey, "revision", latest.Revision, "error", err)
	}
}

func (s *Service) latestNonRetired(ctx context.Context, lineageKey string) (*MemoryRevision, error) {
	revs, err := s.revisions.List(ctx, lineageKey)
	if err != nil {
		return nil, fmt.Errorf("memory: restore source history: %w", err)
	}
	sort.Slice(revs, func(i, j int) bool { return revs[i].Revision < revs[j].Revision })
	for i := len(revs) - 1; i >= 0; i-- {
		if revs[i].RetiredAt == nil {
			cp := revs[i]
			return &cp, nil
		}
	}
	return nil, ErrMemoryNotFound
}

func validateMutationInput(execScope runtimectx.MemoryScope, memoryID, scope string, expectedRevision *int, reason string) error {
	if err := validateExecutionScope(execScope); err != nil {
		return err
	}
	if !validScope(scope) {
		return ErrInvalidScope
	}
	if err := validateSegment("memory_id", memoryID); err != nil {
		return err
	}
	if expectedRevision == nil {
		return ErrExpectedRevisionRequired
	}
	if *expectedRevision <= 0 {
		return fmt.Errorf("%w: expected_revision must be positive", ErrInvalidDocument)
	}
	if strings.TrimSpace(reason) == "" {
		return fmt.Errorf("%w: reason is required", ErrInvalidDocument)
	}
	return nil
}

func validateBody(body string, maxBytes int) error {
	if strings.TrimSpace(body) == "" {
		return fmt.Errorf("%w: content is required", ErrInvalidDocument)
	}
	if len(body) > maxBytes {
		return fmt.Errorf("%w: content exceeds max body size", ErrInvalidDocument)
	}
	return nil
}

type patchSpan struct {
	start int
	end   int
	edit  MemoryPatchEdit
}

func applyPatchEdits(body string, edits []MemoryPatchEdit, maxBytes int) (string, error) {
	if len(edits) == 0 {
		return "", fmt.Errorf("%w: edits are required", ErrInvalidDocument)
	}
	spans := make([]patchSpan, 0, len(edits))
	for _, edit := range edits {
		if edit.OldText == "" {
			return "", fmt.Errorf("%w: old_text is required", ErrInvalidDocument)
		}
		matches := matchOffsets(body, edit.OldText)
		if len(matches) == 0 {
			return "", fmt.Errorf("%w: old_text did not match", ErrInvalidDocument)
		}
		if len(matches) > 1 {
			return "", fmt.Errorf("%w: old_text matched more than once", ErrInvalidDocument)
		}
		first := matches[0]
		spans = append(spans, patchSpan{start: first, end: first + len(edit.OldText), edit: edit})
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end {
			return "", fmt.Errorf("%w: patch spans overlap", ErrInvalidDocument)
		}
	}
	out := body
	for i := len(spans) - 1; i >= 0; i-- {
		span := spans[i]
		out = out[:span.start] + span.edit.NewText + out[span.end:]
	}
	if err := validateBody(out, maxBytes); err != nil {
		return "", err
	}
	return out, nil
}

func matchOffsets(body, needle string) []int {
	offsets := []int{}
	for start := 0; start <= len(body)-len(needle); {
		idx := strings.Index(body[start:], needle)
		if idx < 0 {
			break
		}
		pos := start + idx
		offsets = append(offsets, pos)
		start = pos + 1
	}
	return offsets
}

func createCollisionError(latest MemoryRevision) error {
	if latest.RetiredAt != nil {
		return fmt.Errorf("%w: retired memory exists; use memory_restore or choose a new memory_id", ErrMemoryExists)
	}
	return fmt.Errorf("%w: active memory exists; use memory_patch or memory_update", ErrMemoryExists)
}

func nextRevisionFrom(latest MemoryRevision, now time.Time, op, reason string) MemoryRevision {
	return MemoryRevision{
		LineageKey: latest.LineageKey,
		Revision:   latest.Revision + 1,
		Operation:  op,
		Reason:     strings.TrimSpace(reason),
		UserID:     latest.UserID,
		AgentID:    latest.AgentID,
		ThreadID:   latest.ThreadID,
		MemoryID:   latest.MemoryID,
		Scope:      latest.Scope,
		Type:       latest.Type,
		Importance: latest.Importance,
		CreatedAt:  latest.CreatedAt,
		UpdatedAt:  now,
		ExpiresAt:  latest.ExpiresAt,
	}
}

func isExpired(doc MemoryDocument, now time.Time) bool {
	return doc.ExpiresAt != nil && !doc.ExpiresAt.After(now)
}

func isExpiredRevision(rev MemoryRevision, now time.Time) bool {
	return rev.ExpiresAt != nil && !rev.ExpiresAt.After(now)
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

func snippetAroundLine(body string, absoluteLine int) string {
	lines := strings.Split(body, "\n")
	relativeLine := absoluteLine - 1
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

func extractSummary(body string) string {
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		trimmed = strings.TrimLeft(trimmed, "#")
		trimmed = strings.TrimSpace(trimmed)
		if trimmed == "" {
			continue
		}
		r := []rune(trimmed)
		if len(r) > SummaryMaxChars {
			return string(r[:SummaryMaxChars-1]) + "..."
		}
		return trimmed
	}
	return ""
}

func documentBodyPath(root string, doc MemoryDocument) (string, error) {
	rev := MemoryRevision{
		UserID:   doc.UserID,
		AgentID:  doc.AgentID,
		ThreadID: doc.ThreadID,
		MemoryID: doc.ID,
		Scope:    doc.Scope,
		Revision: doc.Revision,
		BodyPath: doc.BodyPath,
	}
	if err := requireStoredBodyPath(rev); err != nil {
		return "", err
	}
	return RevisionBodyPath(root, rev)
}

func documentFromRevision(rev MemoryRevision, body string) MemoryDocument {
	return MemoryDocument{
		LineageKey: rev.LineageKey,
		UserID:     rev.UserID,
		AgentID:    rev.AgentID,
		ThreadID:   rev.ThreadID,
		ID:         rev.MemoryID,
		Type:       rev.Type,
		Scope:      rev.Scope,
		Importance: rev.Importance,
		Revision:   rev.Revision,
		BodyPath:   rev.BodyPath,
		CreatedAt:  rev.CreatedAt,
		UpdatedAt:  rev.UpdatedAt,
		ExpiresAt:  rev.ExpiresAt,
		RetiredAt:  rev.RetiredAt,
		Summary:    extractSummary(body),
		Body:       body,
	}
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
		Revision:   doc.Revision,
		Retired:    doc.RetiredAt != nil,
		CreatedAt:  doc.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:  doc.UpdatedAt.UTC().Format(time.RFC3339),
		ExpiresAt:  expiresAt,
	}
}

func writeResultFromRevision(rev MemoryRevision) *WriteResult {
	var expiresAt *string
	if rev.ExpiresAt != nil {
		v := rev.ExpiresAt.UTC().Format(time.RFC3339)
		expiresAt = &v
	}
	return &WriteResult{
		MemoryID:  rev.MemoryID,
		Scope:     rev.Scope,
		Revision:  rev.Revision,
		CreatedAt: rev.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: rev.UpdatedAt.UTC().Format(time.RFC3339),
		ExpiresAt: expiresAt,
	}
}

func mutationResultFromRevision(rev MemoryRevision) *MutationResult {
	var expiresAt *string
	if rev.ExpiresAt != nil {
		v := rev.ExpiresAt.UTC().Format(time.RFC3339)
		expiresAt = &v
	}
	return &MutationResult{
		MemoryID:  rev.MemoryID,
		Scope:     rev.Scope,
		Revision:  rev.Revision,
		Retired:   rev.RetiredAt != nil,
		UpdatedAt: rev.UpdatedAt.UTC().Format(time.RFC3339),
		ExpiresAt: expiresAt,
	}
}

func historyRevisionFromRevision(rev MemoryRevision) HistoryRevision {
	var expiresAt *string
	if rev.ExpiresAt != nil {
		v := rev.ExpiresAt.UTC().Format(time.RFC3339)
		expiresAt = &v
	}
	var retiredAt *string
	if rev.RetiredAt != nil {
		v := rev.RetiredAt.UTC().Format(time.RFC3339)
		retiredAt = &v
	}
	return HistoryRevision{
		Revision:     rev.Revision,
		Operation:    rev.Operation,
		Reason:       rev.Reason,
		RestoredFrom: rev.RestoredFrom,
		BodyPath:     rev.BodyPath,
		Type:         rev.Type,
		Importance:   rev.Importance,
		Retired:      rev.RetiredAt != nil,
		CreatedAt:    rev.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:    rev.UpdatedAt.UTC().Format(time.RFC3339),
		ExpiresAt:    expiresAt,
		RetiredAt:    retiredAt,
	}
}
