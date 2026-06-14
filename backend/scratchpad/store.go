package scratchpad

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"backend/fsatomic"
)

// writeJSONAtomic marshals v and writes it via an atomic temp+rename.
func writeJSONAtomic(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("scratchpad: marshal %s: %w", filepath.Base(path), err)
	}
	return fsatomic.WriteFileAtomic(path, string(data))
}

// readJSON reads+unmarshals path. found=false (nil err) when the file is absent.
func readJSON(path string, maxBytes int, v any) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("scratchpad: stat %s: %w", filepath.Base(path), err)
	}
	if info.Size() > int64(maxBytes) {
		return false, fmt.Errorf("scratchpad: %s exceeds %d bytes", filepath.Base(path), maxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, fmt.Errorf("scratchpad: read %s: %w", filepath.Base(path), err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return false, fmt.Errorf("scratchpad: decode %s: %w", filepath.Base(path), err)
	}
	return true, nil
}

func (s *Service) loadFileMeta(ws Workspace, fileID string) (FileMeta, bool, error) {
	path, err := FileMetaPath(s.cfg.Root, ws, fileID)
	if err != nil {
		return FileMeta{}, false, err
	}
	var fm FileMeta
	found, err := readJSON(path, s.cfg.Limits.MaxSectionBytes+4096, &fm)
	return fm, found, err
}

func (s *Service) writeFileMeta(ws Workspace, fm FileMeta) error {
	path, err := FileMetaPath(s.cfg.Root, ws, fm.FileID)
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, fm)
}

func (s *Service) loadSectionMeta(ws Workspace, fileID, sectionID string) (SectionMeta, bool, error) {
	path, err := SectionMetaPath(s.cfg.Root, ws, fileID, sectionID)
	if err != nil {
		return SectionMeta{}, false, err
	}
	var sm SectionMeta
	found, err := readJSON(path, s.cfg.Limits.MaxSectionBytes+4096, &sm)
	return sm, found, err
}

func (s *Service) writeSectionMeta(ws Workspace, sm SectionMeta) error {
	path, err := SectionMetaPath(s.cfg.Root, ws, sm.FileID, sm.SectionID)
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, sm)
}

// writeContentFile writes an immutable content blob (named by its hash) and
// returns the hash. Idempotent: an existing identical blob is left untouched.
func (s *Service) writeContentFile(ws Workspace, fileID, sectionID, content string) (string, error) {
	hash := ContentHash(content)
	path, err := ContentPath(s.cfg.Root, ws, fileID, sectionID, hash)
	if err != nil {
		return "", err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		return hash, nil
	} else if !os.IsNotExist(statErr) {
		return "", fmt.Errorf("scratchpad: stat content: %w", statErr)
	}
	if err := fsatomic.WriteFileAtomic(path, content); err != nil {
		return "", err
	}
	return hash, nil
}

// readContentVerified reads a section's committed content and checks it against
// the recorded content_hash (guards hand-edits / crash leftovers).
func (s *Service) readContentVerified(ws Workspace, sm SectionMeta) (string, error) {
	sd, err := SectionDir(s.cfg.Root, ws, sm.FileID, sm.SectionID)
	if err != nil {
		return "", err
	}
	path := filepath.Join(sd, sm.ContentFile)
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", ErrCorruptSection
		}
		return "", fmt.Errorf("scratchpad: stat content: %w", err)
	}
	if info.Size() > int64(s.cfg.Limits.MaxSectionBytes) {
		return "", ErrCorruptSection
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("scratchpad: read content: %w", err)
	}
	if ContentHash(string(data)) != sm.ContentHash {
		return "", ErrCorruptSection
	}
	return string(data), nil
}

// listSectionMetas returns a file's committed sections, ordered by ordinal then
// section_id. A section dir whose meta.json is absent (incomplete/orphan) is
// skipped — meta.json is the commit pointer.
func (s *Service) listSectionMetas(ws Workspace, fileID string) ([]SectionMeta, error) {
	fd, err := FileDir(s.cfg.Root, ws, fileID)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(fd, "sections"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("scratchpad: read sections dir: %w", err)
	}
	out := make([]SectionMeta, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		sm, found, err := s.loadSectionMeta(ws, fileID, e.Name())
		if err != nil {
			return nil, err
		}
		if !found {
			continue // incomplete: content written but meta not yet committed
		}
		out = append(out, sm)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Ordinal != out[j].Ordinal {
			return out[i].Ordinal < out[j].Ordinal
		}
		return out[i].SectionID < out[j].SectionID
	})
	return out, nil
}

func (s *Service) listFileDirIDs(ws Workspace) ([]string, error) {
	wd, err := WorkspaceDir(s.cfg.Root, ws)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(wd, "files"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("scratchpad: read files dir: %w", err)
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() {
			ids = append(ids, e.Name())
		}
	}
	return ids, nil
}

// listCommittedFileIDs returns only files that have file metadata and at least
// one committed section marker. A bare files/{id}/ directory, or a file whose
// create crashed before the initial section meta.json landed, is not visible to
// caps, list, search, or the context-builder pointer.
func (s *Service) listCommittedFileIDs(ws Workspace) ([]string, error) {
	ids, err := s.listFileDirIDs(ws)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(ids))
	for _, fid := range ids {
		if _, found, err := s.loadFileMeta(ws, fid); err != nil {
			return nil, err
		} else if !found {
			continue
		}
		metas, err := s.listSectionMetas(ws, fid)
		if err != nil {
			return nil, err
		}
		if len(metas) == 0 {
			continue
		}
		out = append(out, fid)
	}
	sort.Strings(out)
	return out, nil
}

// workspaceContentBytes sums the byte size of every committed section's content
// file across the workspace (used for the workspace-bytes cap).
func (s *Service) workspaceContentBytes(ws Workspace) (int, error) {
	ids, err := s.listCommittedFileIDs(ws)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, fid := range ids {
		metas, err := s.listSectionMetas(ws, fid)
		if err != nil {
			return 0, err
		}
		for _, sm := range metas {
			sd, err := SectionDir(s.cfg.Root, ws, fid, sm.SectionID)
			if err != nil {
				return 0, err
			}
			if info, statErr := os.Stat(filepath.Join(sd, sm.ContentFile)); statErr == nil {
				total += int(info.Size())
			}
		}
	}
	return total, nil
}

func (s *Service) loadMutationEntry(ws Workspace, mutationID string) (MutationLogEntry, bool, error) {
	path, err := MutationPath(s.cfg.Root, ws, mutationID)
	if err != nil {
		return MutationLogEntry{}, false, err
	}
	var e MutationLogEntry
	found, err := readJSON(path, 64*1024, &e)
	return e, found, err
}

func (s *Service) writeMutationEntry(ws Workspace, e MutationLogEntry) error {
	path, err := MutationPath(s.cfg.Root, ws, e.MutationID)
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, e)
}
