package scratchpad

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

func newTestService(t *testing.T, lim Limits) *Service {
	t.Helper()
	return NewService(Config{Root: t.TempDir(), RGPath: "rg", Limits: lim})
}

func testWS() Workspace { return Workspace{UserID: "u1", OriginatorRunID: "run-orig"} }

func mustCreate(t *testing.T, s *Service, agentID, runID, tcID, title, heading, content string) *WriteResult {
	t.Helper()
	res, err := s.Create(context.Background(), testWS(), agentID, CreateArgs{
		Title: title, Heading: heading, Content: content, RunID: runID, ToolCallID: tcID,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return res
}

func mustAppend(t *testing.T, s *Service, agentID, runID, tcID, fileID, heading, content string) *WriteResult {
	t.Helper()
	res, err := s.Append(context.Background(), testWS(), agentID, AppendArgs{
		FileID: fileID, Heading: heading, Content: content, RunID: runID, ToolCallID: tcID,
	})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	return res
}

// ── deterministic ids ───────────────────────────────────────────────────────

func TestDeterministicIDs(t *testing.T) {
	mid, err := MutationID("run-1", "call-1")
	if err != nil {
		t.Fatal(err)
	}
	if mid != "run-1:call-1" {
		t.Fatalf("mutation id = %q", mid)
	}
	if FileID(mid) != "spfile_"+ShortSHA(mid) || SectionID(mid) != "spsec_"+ShortSHA(mid) {
		t.Fatal("id helpers not stable")
	}
	if _, err := MutationID("", "call"); err == nil {
		t.Fatal("expected error for empty run id")
	}
	if len(ShortSHA("x")) != 16 {
		t.Fatalf("ShortSHA must be 16 hex chars, got %d", len(ShortSHA("x")))
	}
}

// ── replay idempotency ──────────────────────────────────────────────────────

func TestReplayCreateAppendReplace(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()

	c1 := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "first body")
	c2 := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "first body") // replay
	if c1.FileID != c2.FileID || c1.SectionID != c2.SectionID {
		t.Fatal("create replay produced different ids")
	}
	if c2.Created {
		t.Fatal("create replay must report Created=false")
	}
	if l, _ := s.List(ctx, ws); len(l.Files) != 1 {
		t.Fatalf("create replay duplicated file: %d", len(l.Files))
	}

	a1 := mustAppend(t, s, "B", "r2", "c2", c1.FileID, "Finding", "b body")
	a2 := mustAppend(t, s, "B", "r2", "c2", c1.FileID, "Finding", "b body") // replay
	if a1.SectionID != a2.SectionID || a2.Created {
		t.Fatal("append replay not idempotent")
	}
	secs, _ := s.GetSections(ctx, ws, c1.FileID)
	if len(secs.Sections) != 2 {
		t.Fatalf("append replay duplicated section: %d", len(secs.Sections))
	}

	rp1, err := s.Replace(ctx, ws, "B", ReplaceArgs{
		FileID: c1.FileID, SectionID: a1.SectionID, Heading: "Finding", Content: "b body v2",
		ExpectedHash: a1.ContentHash, RunID: "r3", ToolCallID: "c3",
	})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	rp2, err := s.Replace(ctx, ws, "B", ReplaceArgs{
		FileID: c1.FileID, SectionID: a1.SectionID, Heading: "Finding", Content: "b body v2",
		ExpectedHash: a1.ContentHash, RunID: "r3", ToolCallID: "c3", // replay (same mutation)
	})
	if err != nil {
		t.Fatalf("replace replay: %v", err)
	}
	if rp1.ContentHash != rp2.ContentHash || rp2.Created {
		t.Fatal("replace replay not idempotent")
	}
	got, _ := s.ReadSection(ctx, ws, c1.FileID, a1.SectionID)
	if got.Content != "b body v2" {
		t.Fatalf("replace content = %q", got.Content)
	}
}

// ── op/target mismatch on a reused mutation id ──────────────────────────────

func TestMutationConflict(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")
	// Reuse the SAME (run_id, tool_call_id) for an append → same mutation id,
	// different op/target → must conflict, never a false success.
	_, err := s.Append(context.Background(), ws, "A", AppendArgs{
		FileID: c.FileID, Heading: "X", Content: "y", RunID: "r1", ToolCallID: "c1",
	})
	if err != ErrMutationConflict {
		t.Fatalf("expected ErrMutationConflict, got %v", err)
	}
}

func TestMutationConflictSameTargetDifferentContent(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()

	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")
	_, err := s.Create(ctx, ws, "A", CreateArgs{
		Title: "Plan", Heading: "Intro", Content: "different body", RunID: "r1", ToolCallID: "c1",
	})
	if err != ErrMutationConflict {
		t.Fatalf("create replay with different content: got %v", err)
	}

	a := mustAppend(t, s, "A", "r2", "c2", c.FileID, "Finding", "append body")
	_, err = s.Append(ctx, ws, "A", AppendArgs{
		FileID: c.FileID, Heading: "Finding", Content: "different append body", RunID: "r2", ToolCallID: "c2",
	})
	if err != ErrMutationConflict {
		t.Fatalf("append replay with different content: got %v", err)
	}

	_, err = s.Replace(ctx, ws, "A", ReplaceArgs{
		FileID: c.FileID, SectionID: a.SectionID, Heading: "Finding", Content: "replace body",
		ExpectedHash: a.ContentHash, RunID: "r3", ToolCallID: "c3",
	})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	_, err = s.Replace(ctx, ws, "A", ReplaceArgs{
		FileID: c.FileID, SectionID: a.SectionID, Heading: "Finding", Content: "different replace body",
		ExpectedHash: a.ContentHash, RunID: "r3", ToolCallID: "c3",
	})
	if err != ErrMutationConflict {
		t.Fatalf("replace replay with different content: got %v", err)
	}
}

// ── crash safety: replace torn write / orphan content invisible ─────────────

func TestOrphanContentInvisible(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "committed body")

	// Simulate a crash mid-replace: a new immutable content file landed but the
	// section meta.json was never re-pointed at it. The old committed state must
	// remain fully intact and the orphan must be invisible everywhere.
	orphanHash := ContentHash("orphan never-committed text")
	op, err := ContentPath(s.cfg.Root, ws, c.FileID, c.SectionID, orphanHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(op), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(op, []byte("orphan never-committed text"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := s.ReadSection(ctx, ws, c.FileID, c.SectionID)
	if err != nil || got.Content != "committed body" {
		t.Fatalf("read after orphan write = %q, %v (want committed body)", got.Content, err)
	}
	requireRG(t)
	hits, err := s.Search(ctx, ws, SearchArgs{Pattern: "orphan never-committed"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 0 {
		t.Fatalf("orphan content surfaced in search: %+v", hits.Hits)
	}
}

// ── crash safety: section dir with content but no committed meta is invisible ─

func TestIncompleteSectionInvisible(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")

	// Hand-create a section dir with content but NO meta.json (the commit
	// pointer). It must be invisible to listing/read/search.
	sd, _ := SectionDir(s.cfg.Root, ws, c.FileID, "spsec_deadbeefdeadbeef")
	if err := os.MkdirAll(filepath.Join(sd, "content"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sd, "content", "x.md"), []byte("ghost"), 0o644); err != nil {
		t.Fatal(err)
	}
	secs, _ := s.GetSections(ctx, ws, c.FileID)
	if len(secs.Sections) != 1 {
		t.Fatalf("incomplete section leaked into get_sections: %d", len(secs.Sections))
	}
}

// ── crash safety: create that crashed before its section commits, then replays ─

func TestCreateReplayAfterLostSection(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")

	// Simulate "committed file meta + mutation log, but section meta lost before
	// it was durable" by deleting the section meta AND the mutation log entry.
	smPath, _ := SectionMetaPath(s.cfg.Root, ws, c.FileID, c.SectionID)
	if err := os.Remove(smPath); err != nil {
		t.Fatal(err)
	}
	mp, _ := MutationPath(s.cfg.Root, ws, "r1:c1")
	_ = os.Remove(mp)

	if secs, _ := s.GetSections(ctx, ws, c.FileID); len(secs.Sections) != 0 {
		t.Fatalf("section falsely present before replay: %d", len(secs.Sections))
	}
	// Replay the create (same ids) → section is restored, no duplicate file.
	c2 := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")
	if c2.FileID != c.FileID || c2.SectionID != c.SectionID {
		t.Fatal("replay changed ids")
	}
	if secs, _ := s.GetSections(ctx, ws, c.FileID); len(secs.Sections) != 1 {
		t.Fatalf("replay did not restore the lost section: %d", len(secs.Sections))
	}
	if l, _ := s.List(ctx, ws); len(l.Files) != 1 {
		t.Fatalf("replay duplicated file: %d", len(l.Files))
	}
}

func TestCreateReplayAfterLostSectionAtFileCap(t *testing.T) {
	s := newTestService(t, Limits{MaxFilesPerWorkspace: 1})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")

	smPath, _ := SectionMetaPath(s.cfg.Root, ws, c.FileID, c.SectionID)
	if err := os.Remove(smPath); err != nil {
		t.Fatal(err)
	}
	mp, _ := MutationPath(s.cfg.Root, ws, "r1:c1")
	_ = os.Remove(mp)

	if got := s.CountFiles(ws); got != 0 {
		t.Fatalf("incomplete create counted as committed file: %d", got)
	}
	if l, _ := s.List(ctx, ws); len(l.Files) != 0 {
		t.Fatalf("incomplete create leaked into list: %d", len(l.Files))
	}

	replayed, err := s.Create(ctx, ws, "A", CreateArgs{
		Title: "Plan", Heading: "Intro", Content: "body", RunID: "r1", ToolCallID: "c1",
	})
	if err != nil {
		t.Fatalf("create replay at cap: %v", err)
	}
	if replayed.FileID != c.FileID || replayed.SectionID != c.SectionID {
		t.Fatal("replay changed ids")
	}
	if got := s.CountFiles(ws); got != 1 {
		t.Fatalf("repaired file not counted: %d", got)
	}
}

// ── concurrent appends: lock serializes, ordinals unique, none lost ─────────

func TestConcurrentAppends(t *testing.T) {
	s := newTestService(t, Limits{MaxSectionsPerFile: 100})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "body")

	const n = 16
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = s.Append(ctx, ws, "A", AppendArgs{
				FileID: c.FileID, Heading: fmt.Sprintf("h%d", i), Content: fmt.Sprintf("body %d", i),
				RunID: "r2", ToolCallID: fmt.Sprintf("c%d", i),
			})
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Fatalf("append %d: %v", i, e)
		}
	}
	secs, _ := s.GetSections(ctx, ws, c.FileID)
	if len(secs.Sections) != n+1 {
		t.Fatalf("expected %d sections, got %d", n+1, len(secs.Sections))
	}
	seenOrd := map[int]bool{}
	seenID := map[string]bool{}
	for _, sec := range secs.Sections {
		if seenOrd[sec.Ordinal] {
			t.Fatalf("duplicate ordinal %d", sec.Ordinal)
		}
		if seenID[sec.SectionID] {
			t.Fatalf("duplicate section id %s", sec.SectionID)
		}
		seenOrd[sec.Ordinal], seenID[sec.SectionID] = true, true
	}
}

// ── ownership + stale-hash ──────────────────────────────────────────────────

func TestReplaceOwnershipAndHash(t *testing.T) {
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "a body")

	// A different agent cannot replace A's section.
	_, err := s.Replace(ctx, ws, "B", ReplaceArgs{
		FileID: c.FileID, SectionID: c.SectionID, Heading: "Intro", Content: "hijack",
		ExpectedHash: c.ContentHash, RunID: "r2", ToolCallID: "c2",
	})
	if err != ErrNotOwner {
		t.Fatalf("expected ErrNotOwner, got %v", err)
	}

	// Owner with a stale expected_hash is rejected.
	_, err = s.Replace(ctx, ws, "A", ReplaceArgs{
		FileID: c.FileID, SectionID: c.SectionID, Heading: "Intro", Content: "v2",
		ExpectedHash: "stale", RunID: "r3", ToolCallID: "c3",
	})
	if err != ErrHashMismatch {
		t.Fatalf("expected ErrHashMismatch, got %v", err)
	}

	// Owner without expected_hash is rejected; replace is never a blind overwrite.
	_, err = s.Replace(ctx, ws, "A", ReplaceArgs{
		FileID: c.FileID, SectionID: c.SectionID, Heading: "Intro", Content: "v2",
		RunID: "r4", ToolCallID: "c4",
	})
	if err == nil || !strings.Contains(err.Error(), "expected_hash") {
		t.Fatalf("expected missing expected_hash error, got %v", err)
	}
}

func TestAppendToMissingFile(t *testing.T) {
	s := newTestService(t, Limits{})
	_, err := s.Append(context.Background(), testWS(), "A", AppendArgs{
		FileID: "spfile_missing", Heading: "h", Content: "c", RunID: "r1", ToolCallID: "c1",
	})
	if err != ErrFileNotFound {
		t.Fatalf("expected ErrFileNotFound, got %v", err)
	}
}

// ── corruption on read + skip in search ─────────────────────────────────────

func TestContentHashMismatch(t *testing.T) {
	requireRG(t)
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "Intro", "original sentinel body")

	// Hand-edit the immutable content file: bytes change but the path still
	// embeds the old hash → integrity check fails.
	cp, _ := ContentPath(s.cfg.Root, ws, c.FileID, c.SectionID, c.ContentHash)
	if err := os.WriteFile(cp, []byte("tampered different body"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadSection(ctx, ws, c.FileID, c.SectionID); err != ErrCorruptSection {
		t.Fatalf("expected ErrCorruptSection on read, got %v", err)
	}
	hits, err := s.Search(ctx, ws, SearchArgs{Pattern: "tampered different"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 0 {
		t.Fatalf("tampered section surfaced in search: %+v", hits.Hits)
	}
}

// ── caps ────────────────────────────────────────────────────────────────────

func TestStorageCaps(t *testing.T) {
	ctx := context.Background()
	ws := testWS()

	t.Run("max files", func(t *testing.T) {
		s := newTestService(t, Limits{MaxFilesPerWorkspace: 2})
		mustCreate(t, s, "A", "r", "c1", "t", "h", "b")
		mustCreate(t, s, "A", "r", "c2", "t", "h", "b")
		_, err := s.Create(ctx, ws, "A", CreateArgs{Title: "t", Heading: "h", Content: "b", RunID: "r", ToolCallID: "c3"})
		if err != ErrMaxFiles {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("max sections", func(t *testing.T) {
		s := newTestService(t, Limits{MaxSectionsPerFile: 2})
		c := mustCreate(t, s, "A", "r", "c1", "t", "h", "b") // section 1
		mustAppend(t, s, "A", "r", "c2", c.FileID, "h", "b") // section 2
		_, err := s.Append(ctx, ws, "A", AppendArgs{FileID: c.FileID, Heading: "h", Content: "b", RunID: "r", ToolCallID: "c3"})
		if err != ErrMaxSections {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("section too large", func(t *testing.T) {
		s := newTestService(t, Limits{MaxSectionBytes: 8})
		_, err := s.Create(ctx, ws, "A", CreateArgs{Title: "t", Heading: "h", Content: "way too long body", RunID: "r", ToolCallID: "c1"})
		if err != ErrSectionTooLarge {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("workspace too large", func(t *testing.T) {
		s := newTestService(t, Limits{MaxWorkspaceBytes: 20, MaxSectionBytes: 100})
		mustCreate(t, s, "A", "r", "c1", "t", "h", "0123456789") // 10 bytes
		_, err := s.Create(ctx, ws, "A", CreateArgs{Title: "t", Heading: "h", Content: "0123456789abcdef", RunID: "r", ToolCallID: "c2"})
		if err != ErrWorkspaceTooLarge {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("title too long", func(t *testing.T) {
		s := newTestService(t, Limits{MaxTitleBytes: 4})
		_, err := s.Create(ctx, ws, "A", CreateArgs{Title: "toolong", Heading: "h", Content: "b", RunID: "r", ToolCallID: "c1"})
		if err != ErrTitleTooLong {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("heading too long", func(t *testing.T) {
		s := newTestService(t, Limits{MaxHeadingBytes: 4})
		_, err := s.Create(ctx, ws, "A", CreateArgs{Title: "t", Heading: "toolong", Content: "b", RunID: "r", ToolCallID: "c1"})
		if err != ErrHeadingTooLong {
			t.Fatalf("got %v", err)
		}
	})
}

// idempotency precedes limits: a replay of an accepted write still succeeds even
// when the workspace is exactly at its file cap.
func TestCapAfterIdempotency(t *testing.T) {
	s := newTestService(t, Limits{MaxFilesPerWorkspace: 1})
	c1 := mustCreate(t, s, "A", "r1", "c1", "t", "h", "b") // fills the cap
	c2 := mustCreate(t, s, "A", "r1", "c1", "t", "h", "b") // replay at cap → must succeed
	if c1.FileID != c2.FileID || c2.Created {
		t.Fatal("replay at cap not treated as idempotent")
	}
}

// ── output caps ─────────────────────────────────────────────────────────────

func TestSearchLimit(t *testing.T) {
	requireRG(t)
	s := newTestService(t, Limits{MaxSectionsPerFile: 100})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c0", "t", "h0", "needle here")
	for i := 0; i < 9; i++ {
		mustAppend(t, s, "A", "r1", fmt.Sprintf("c%d", i+1), c.FileID, fmt.Sprintf("h%d", i+1), "needle here")
	}
	lim := 3
	hits, err := s.Search(ctx, ws, SearchArgs{Pattern: "needle", Limit: &lim})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 3 {
		t.Fatalf("expected 3 hits (capped), got %d", len(hits.Hits))
	}
}

func TestGetSectionsPreviewTruncates(t *testing.T) {
	s := newTestService(t, Limits{MaxSectionBytes: 64 * 1024})
	ws := testWS()
	ctx := context.Background()
	long := strings.Repeat("x", PreviewBytes+500)
	c := mustCreate(t, s, "A", "r1", "c1", "t", "h", long)
	secs, _ := s.GetSections(ctx, ws, c.FileID)
	if len(secs.Sections) != 1 {
		t.Fatal("expected 1 section")
	}
	if pl := len([]rune(secs.Sections[0].Preview)); pl > PreviewBytes+1 {
		t.Fatalf("preview not truncated: %d runes", pl)
	}
	if secs.Sections[0].SizeBytes != len(long) {
		t.Fatalf("size_bytes = %d, want %d", secs.Sections[0].SizeBytes, len(long))
	}
}

// ── cross-agent correction by append, ordered by ordinal ────────────────────

func TestSearchAndOrdering(t *testing.T) {
	requireRG(t)
	s := newTestService(t, Limits{})
	ws := testWS()
	ctx := context.Background()
	c := mustCreate(t, s, "A", "r1", "c1", "Plan", "A-intro", "alpha content")
	mustAppend(t, s, "B", "r2", "c2", c.FileID, "B-correction", "beta correction unique-token")

	hits, err := s.Search(ctx, ws, SearchArgs{Pattern: "unique-token"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 1 || hits.Hits[0].AuthorAgentID != "B" {
		t.Fatalf("search hits = %+v", hits.Hits)
	}

	secs, _ := s.GetSections(ctx, ws, c.FileID)
	if len(secs.Sections) != 2 {
		t.Fatalf("want 2 sections, got %d", len(secs.Sections))
	}
	ords := []int{secs.Sections[0].Ordinal, secs.Sections[1].Ordinal}
	if !sort.IntsAreSorted(ords) || ords[0] != 0 || ords[1] != 1 {
		t.Fatalf("sections not ordered by ordinal: %v", ords)
	}
	if secs.Sections[0].AuthorAgentID != "A" || secs.Sections[1].AuthorAgentID != "B" {
		t.Fatal("authorship not preserved across agents")
	}
}

func requireRG(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("ripgrep not available")
	}
}
