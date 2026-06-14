package scratchpad

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"backend/fsatomic"
)

type Service struct {
	cfg   Config
	locks workspaceLocks
}

func NewService(cfg Config) *Service {
	cfg.Limits = cfg.Limits.withDefaults()
	if cfg.RGPath == "" {
		cfg.RGPath = "rg"
	}
	return &Service{cfg: cfg}
}

func NewServiceFromEnv() (*Service, error) {
	root := strings.TrimSpace(os.Getenv("SCRATCHPAD_ROOT"))
	if root == "" {
		root = filepath.Join(os.TempDir(), "agentflow-scratchpad")
	}
	svc := NewService(Config{Root: root, RGPath: os.Getenv("RG_PATH")})
	if err := svc.ValidateStartup(); err != nil {
		return nil, err
	}
	return svc, nil
}

func (s *Service) ValidateStartup() error {
	if err := fsatomic.EnsureDir(s.cfg.Root); err != nil {
		return err
	}
	if _, err := exec.LookPath(s.cfg.RGPath); err != nil {
		return fmt.Errorf("scratchpad: ripgrep (%s) not found: %w", s.cfg.RGPath, err)
	}
	return nil
}

// ── Write path ────────────────────────────────────────────────────────────────

type commitPlan struct {
	op           string
	fileID       string
	sectionID    string
	heading      string
	content      string
	title        string // create only
	agentID      string
	runID        string
	mutationID   string
	expectedHash string       // replace only
	ordinal      int          // append: set in validate; create: 0; replace: carried from prev
	prev         *SectionMeta // replace only
}

func (s *Service) Create(ctx context.Context, ws Workspace, agentID string, a CreateArgs) (*WriteResult, error) {
	if err := requireText("title", a.Title); err != nil {
		return nil, err
	}
	if err := requireText("heading", a.Heading); err != nil {
		return nil, err
	}
	if err := requireText("content", a.Content); err != nil {
		return nil, err
	}
	mid, err := MutationID(a.RunID, a.ToolCallID)
	if err != nil {
		return nil, err
	}
	return s.commit(ctx, ws, commitPlan{
		op: OpCreate, fileID: FileID(mid), sectionID: SectionID(mid),
		heading: a.Heading, content: a.Content, title: a.Title,
		agentID: agentID, runID: a.RunID, mutationID: mid, ordinal: 0,
	})
}

func (s *Service) Append(ctx context.Context, ws Workspace, agentID string, a AppendArgs) (*WriteResult, error) {
	if err := requireText("file_id", a.FileID); err != nil {
		return nil, err
	}
	if err := requireText("heading", a.Heading); err != nil {
		return nil, err
	}
	if err := requireText("content", a.Content); err != nil {
		return nil, err
	}
	mid, err := MutationID(a.RunID, a.ToolCallID)
	if err != nil {
		return nil, err
	}
	return s.commit(ctx, ws, commitPlan{
		op: OpAppend, fileID: a.FileID, sectionID: SectionID(mid),
		heading: a.Heading, content: a.Content,
		agentID: agentID, runID: a.RunID, mutationID: mid,
	})
}

func (s *Service) Replace(ctx context.Context, ws Workspace, agentID string, a ReplaceArgs) (*WriteResult, error) {
	if err := requireText("file_id", a.FileID); err != nil {
		return nil, err
	}
	if err := requireText("section_id", a.SectionID); err != nil {
		return nil, err
	}
	if err := requireText("heading", a.Heading); err != nil {
		return nil, err
	}
	if err := requireText("content", a.Content); err != nil {
		return nil, err
	}
	if err := requireText("expected_hash", a.ExpectedHash); err != nil {
		return nil, err
	}
	mid, err := MutationID(a.RunID, a.ToolCallID)
	if err != nil {
		return nil, err
	}
	return s.commit(ctx, ws, commitPlan{
		op: OpReplace, fileID: a.FileID, sectionID: a.SectionID,
		heading: a.Heading, content: a.Content, expectedHash: a.ExpectedHash,
		agentID: agentID, runID: a.RunID, mutationID: mid,
	})
}

func (s *Service) commit(ctx context.Context, ws Workspace, p commitPlan) (*WriteResult, error) {
	if err := ws.validate(); err != nil {
		return nil, err
	}
	// (2) lock-free idempotency fast path
	if res, hit, err := s.idempotentHit(ws, p); err != nil {
		return nil, err
	} else if hit {
		return res, nil
	}
	dir, err := WorkspaceDir(s.cfg.Root, ws)
	if err != nil {
		return nil, err
	}
	unlock := s.locks.lock(dir) // (3)
	defer unlock()
	// (4) recheck under lock
	if res, hit, err := s.idempotentHit(ws, p); err != nil {
		return nil, err
	} else if hit {
		return res, nil
	}
	// (5) ownership / hash / limits
	if err := s.validateForCommit(ws, &p); err != nil {
		return nil, err
	}
	// (6) write content + metadata atomically (commit pointer last)
	res, err := s.writeArtifact(ws, p)
	if err != nil {
		return nil, err
	}
	// (7) mutation log — convenience index, non-fatal
	if err := s.writeMutationEntry(ws, MutationLogEntry{
		SchemaVersion: LayoutVersion, MutationID: p.mutationID, Op: p.op,
		FileID: p.fileID, SectionID: p.sectionID, ContentHash: res.ContentHash,
		At: nowRFC3339(),
	}); err != nil {
		// already durable; replay falls back to the section marker
		_ = err
	}
	return res, nil // (8) unlock via defer
}

func (s *Service) idempotentHit(ws Workspace, p commitPlan) (*WriteResult, bool, error) {
	if e, found, err := s.loadMutationEntry(ws, p.mutationID); err != nil {
		return nil, false, err
	} else if found {
		if e.Op != p.op || e.FileID != p.fileID || e.SectionID != p.sectionID {
			return nil, false, ErrMutationConflict
		}
		if e.ContentHash != ContentHash(p.content) {
			return nil, false, ErrMutationConflict
		}
		sm, ok, err := s.loadSectionMeta(ws, p.fileID, p.sectionID)
		if err != nil {
			return nil, false, err
		}
		if ok {
			return writeResultFromMeta(sm, p.op, false), true, nil
		}
		// log present but section missing (rare): fall through and re-apply
		return nil, false, nil
	}
	sm, found, err := s.loadSectionMeta(ws, p.fileID, p.sectionID)
	if err != nil {
		return nil, false, err
	}
	switch p.op {
	case OpCreate, OpAppend:
		if found {
			if sm.ContentHash != ContentHash(p.content) {
				return nil, false, ErrMutationConflict
			}
			return writeResultFromMeta(sm, p.op, false), true, nil
		}
	case OpReplace:
		if found && sm.LastMutationID == p.mutationID {
			if sm.ContentHash != ContentHash(p.content) {
				return nil, false, ErrMutationConflict
			}
			return writeResultFromMeta(sm, p.op, false), true, nil
		}
	}
	return nil, false, nil
}

func (s *Service) validateForCommit(ws Workspace, p *commitPlan) error {
	lim := s.cfg.Limits
	if len(p.content) > lim.MaxSectionBytes {
		return ErrSectionTooLarge
	}
	if len([]byte(p.heading)) > lim.MaxHeadingBytes {
		return ErrHeadingTooLong
	}
	if p.op == OpCreate && len([]byte(p.title)) > lim.MaxTitleBytes {
		return ErrTitleTooLong
	}

	oldSize := 0
	switch p.op {
	case OpCreate:
		ids, err := s.listCommittedFileIDs(ws)
		if err != nil {
			return err
		}
		if len(ids) >= lim.MaxFilesPerWorkspace {
			return ErrMaxFiles
		}
	case OpAppend:
		if _, found, err := s.loadFileMeta(ws, p.fileID); err != nil {
			return err
		} else if !found {
			return ErrFileNotFound
		}
		metas, err := s.listSectionMetas(ws, p.fileID)
		if err != nil {
			return err
		}
		if len(metas) >= lim.MaxSectionsPerFile {
			return ErrMaxSections
		}
		p.ordinal = nextOrdinal(metas)
	case OpReplace:
		sm, found, err := s.loadSectionMeta(ws, p.fileID, p.sectionID)
		if err != nil {
			return err
		}
		if !found {
			return ErrSectionNotFound
		}
		if sm.OwnerAgentID != p.agentID {
			return ErrNotOwner
		}
		if p.expectedHash == "" {
			return fmt.Errorf("%w: expected_hash is required", ErrInvalidArgs)
		}
		if sm.ContentHash != p.expectedHash {
			return ErrHashMismatch
		}
		oldSize = sm.SizeBytes
		p.prev = &sm
	}

	// workspace-bytes cap (logical: referenced content). Replace uses the delta.
	cur, err := s.workspaceContentBytes(ws)
	if err != nil {
		return err
	}
	if cur-oldSize+len(p.content) > lim.MaxWorkspaceBytes {
		return ErrWorkspaceTooLarge
	}
	return nil
}

func (s *Service) writeArtifact(ws Workspace, p commitPlan) (*WriteResult, error) {
	now := nowRFC3339()
	hash, err := s.writeContentFile(ws, p.fileID, p.sectionID, p.content) // immutable, first
	if err != nil {
		return nil, err
	}
	if p.op == OpCreate {
		if err := s.writeFileMeta(ws, FileMeta{
			SchemaVersion: LayoutVersion, FileID: p.fileID, Title: p.title,
			CreatedByAgent: p.agentID, CreatedByRunID: p.runID, CreatedAt: now,
		}); err != nil {
			return nil, err
		}
	}
	sm := SectionMeta{
		SchemaVersion: LayoutVersion, SectionID: p.sectionID, FileID: p.fileID,
		Heading: p.heading, OwnerAgentID: p.agentID, Ordinal: p.ordinal,
		ContentFile: contentRelPath(hash), ContentHash: hash,
		SizeBytes: len(p.content), Preview: preview(p.content),
		LastMutationID: p.mutationID, CreatedByRunID: p.runID, LastEditedByRunID: p.runID,
		CreatedAt: now, UpdatedAt: now,
	}
	if p.op == OpReplace && p.prev != nil {
		sm.Ordinal = p.prev.Ordinal
		sm.OwnerAgentID = p.prev.OwnerAgentID
		sm.CreatedByRunID = p.prev.CreatedByRunID
		sm.CreatedAt = p.prev.CreatedAt
	}
	if err := s.writeSectionMeta(ws, sm); err != nil { // commit pointer, last
		return nil, err
	}
	return writeResultFromMeta(sm, p.op, true), nil
}

// ── Read path (no lock) ─────────────────────────────────────────────────────

func (s *Service) List(ctx context.Context, ws Workspace) (*ListResult, error) {
	if err := ws.validate(); err != nil {
		return nil, err
	}
	ids, err := s.listCommittedFileIDs(ws)
	if err != nil {
		return nil, err
	}
	out := &ListResult{Files: []FileSummary{}}
	for _, fid := range ids {
		fm, found, err := s.loadFileMeta(ws, fid)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		metas, err := s.listSectionMetas(ws, fid)
		if err != nil {
			return nil, err
		}
		size := 0
		for _, sm := range metas {
			size += sm.SizeBytes
		}
		out.Files = append(out.Files, FileSummary{
			FileID: fm.FileID, Title: fm.Title, CreatedByAgent: fm.CreatedByAgent,
			SectionCount: len(metas), SizeBytes: size,
		})
	}
	return out, nil
}

func (s *Service) GetSections(ctx context.Context, ws Workspace, fileID string) (*GetSectionsResult, error) {
	if err := ws.validate(); err != nil {
		return nil, err
	}
	fm, found, err := s.loadFileMeta(ws, fileID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrFileNotFound
	}
	metas, err := s.listSectionMetas(ws, fileID)
	if err != nil {
		return nil, err
	}
	res := &GetSectionsResult{FileID: fm.FileID, Title: fm.Title, Sections: []SectionSummary{}}
	for _, sm := range metas {
		res.Sections = append(res.Sections, SectionSummary{
			SectionID: sm.SectionID, Heading: sm.Heading, AuthorAgentID: sm.OwnerAgentID,
			Ordinal: sm.Ordinal, SizeBytes: sm.SizeBytes, ContentHash: sm.ContentHash,
			Preview: sm.Preview,
		})
	}
	return res, nil
}

func (s *Service) ReadSection(ctx context.Context, ws Workspace, fileID, sectionID string) (*ReadSectionResult, error) {
	if err := ws.validate(); err != nil {
		return nil, err
	}
	sm, found, err := s.loadSectionMeta(ws, fileID, sectionID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrSectionNotFound
	}
	content, err := s.readContentVerified(ws, sm)
	if err != nil {
		return nil, err
	}
	return &ReadSectionResult{
		SectionID: sm.SectionID, Heading: sm.Heading, AuthorAgentID: sm.OwnerAgentID,
		Content: content, ContentHash: sm.ContentHash,
	}, nil
}

// CountFiles is a cheap pointer for the context-builder's <scratchpad> block.
func (s *Service) CountFiles(ws Workspace) int {
	ids, err := s.listCommittedFileIDs(ws)
	if err != nil {
		return 0
	}
	return len(ids)
}

// ── helpers ─────────────────────────────────────────────────────────────────

func requireText(name, v string) error {
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalidArgs, name)
	}
	return nil
}

func nextOrdinal(metas []SectionMeta) int {
	max := -1
	for _, m := range metas {
		if m.Ordinal > max {
			max = m.Ordinal
		}
	}
	return max + 1
}

func writeResultFromMeta(sm SectionMeta, op string, created bool) *WriteResult {
	return &WriteResult{
		FileID: sm.FileID, SectionID: sm.SectionID, Heading: sm.Heading,
		OwnerAgentID: sm.OwnerAgentID, ContentHash: sm.ContentHash, Op: op, Created: created,
	}
}

func preview(content string) string {
	c := strings.TrimSpace(content)
	if len(c) <= PreviewBytes {
		return c
	}
	r := []rune(c)
	if len(r) <= PreviewBytes {
		return c
	}
	return string(r[:PreviewBytes]) + "…"
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }
