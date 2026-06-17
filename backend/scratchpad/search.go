package scratchpad

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type rgEnvelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type rgMatchData struct {
	Path       rgText `json:"path"`
	Lines      rgText `json:"lines"`
	LineNumber int    `json:"line_number"`
}

type rgText struct {
	Text string `json:"text"`
}

// Search runs a fixed-string, case-insensitive ripgrep over the workspace's
// currently-referenced section content files and returns attributed hits.
// Reads don't lock. Each hit's content is hash-verified; a mismatch (hand-edit
// or crash leftover) is skipped rather than surfaced.
func (s *Service) Search(ctx context.Context, ws Workspace, a SearchArgs) (*SearchResult, error) {
	if err := ws.validate(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Pattern) == "" {
		return nil, fmt.Errorf("%w: pattern is required", ErrInvalidArgs)
	}
	limit := DefaultSearchLimit
	if a.Limit != nil {
		if *a.Limit > 0 {
			limit = *a.Limit
		}
		if limit > MaxSearchLimit {
			limit = MaxSearchLimit
		}
	}

	fileIDs, err := s.listFileDirIDs(ws)
	if err != nil {
		return nil, err
	}
	byPath := make(map[string]SectionMeta)
	var files []string
	for _, fid := range fileIDs {
		if _, found, err := s.loadFileMeta(ws, fid); err != nil {
			return nil, err
		} else if !found {
			continue
		}
		metas, err := s.listSectionMetas(ws, fid)
		if err != nil {
			return nil, err
		}
		for _, sm := range metas {
			sd, err := SectionDir(s.cfg.Root, ws, fid, sm.SectionID)
			if err != nil {
				return nil, err
			}
			p := filepath.Join(sd, sm.ContentFile)
			byPath[p] = sm
			files = append(files, p)
		}
	}
	res := &SearchResult{Hits: []SearchHit{}}
	if len(files) == 0 {
		return res, nil
	}

	matches, err := s.runRG(ctx, a.Pattern, files)
	if err != nil {
		return nil, err
	}
	// Deterministic order: by file path (which embeds file_id/section_id).
	paths := make([]string, 0, len(matches))
	for p := range matches {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	for _, p := range paths {
		if len(res.Hits) >= limit {
			break
		}
		sm := byPath[p]
		// hash-verify: filename embeds the hash, so a hand-edit fails this.
		data, readErr := os.ReadFile(p)
		if readErr != nil || ContentHash(string(data)) != sm.ContentHash {
			continue
		}
		res.Hits = append(res.Hits, SearchHit{
			FileID: sm.FileID, SectionID: sm.SectionID, Heading: sm.Heading,
			AuthorAgentID: sm.OwnerAgentID, Snippet: snippet(matches[p]),
		})
	}
	return res, nil
}

func (s *Service) runRG(ctx context.Context, pattern string, files []string) (map[string]string, error) {
	args := append([]string{"--json", "-F", "-i", "-n", "--", pattern}, files...)
	cmd := exec.CommandContext(ctx, s.cfg.RGPath, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return map[string]string{}, nil // no matches
		}
		return nil, fmt.Errorf("scratchpad: rg failed: %w: %s", err, stderr.String())
	}
	out := make(map[string]string)
	for _, line := range bytes.Split(stdout.Bytes(), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var env rgEnvelope
		if err := json.Unmarshal(line, &env); err != nil {
			return nil, fmt.Errorf("scratchpad: parse rg output: %w", err)
		}
		if env.Type != "match" {
			continue
		}
		var d rgMatchData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return nil, fmt.Errorf("scratchpad: parse rg match: %w", err)
		}
		if _, ok := out[d.Path.Text]; !ok {
			out[d.Path.Text] = d.Lines.Text // first matching line per file
		}
	}
	return out, nil
}

func snippet(line string) string {
	return preview(strings.ReplaceAll(line, "\n", " "))
}
