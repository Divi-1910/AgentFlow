package scratchpad

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// ShortSHA mirrors the memory subsystem's id encoding (first 8 bytes / 16 hex)
// — used for deterministic file/section ids derived from a mutation id.
func ShortSHA(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:8])
}

// ContentHash is the full sha256 of a section body; doubles as the content
// file's name (content-addressed, so an identical body dedups and a replay
// re-writes the same path).
func ContentHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// MutationID namespaces the tool-call id by run id so a bare tool_call_id can't
// collide across runs (the global idempotency key).
func MutationID(runID, toolCallID string) (string, error) {
	if runID == "" || toolCallID == "" {
		return "", ErrMutationIDMissing
	}
	return runID + ":" + toolCallID, nil
}

func FileID(mutationID string) string    { return "spfile_" + ShortSHA(mutationID) }
func SectionID(mutationID string) string { return "spsec_" + ShortSHA(mutationID) }

// validateSegment rejects path-traversal / control chars / overlong segments.
// (Mirrors memory/scope.go's guard with a scratchpad-neutral error.)
func validateSegment(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalidName, name)
	}
	if value == "." || value == ".." || strings.Contains(value, "/") || strings.Contains(value, `\`) {
		return fmt.Errorf("%w: invalid %s", ErrInvalidName, name)
	}
	if len(value) > MaxSegmentLen {
		return fmt.Errorf("%w: %s exceeds %d chars", ErrInvalidName, name, MaxSegmentLen)
	}
	for _, c := range value {
		if c < 0x20 || c == 0x7F {
			return fmt.Errorf("%w: %s has a control character", ErrInvalidName, name)
		}
	}
	return nil
}

func (ws Workspace) validate() error {
	if err := validateSegment("user_id", ws.UserID); err != nil {
		return err
	}
	return validateSegment("originator_run_id", ws.OriginatorRunID)
}

func WorkspaceDir(root string, ws Workspace) (string, error) {
	if err := ws.validate(); err != nil {
		return "", err
	}
	return filepath.Join(root, ws.UserID, "scratchpads", ws.OriginatorRunID), nil
}

func FileDir(root string, ws Workspace, fileID string) (string, error) {
	wd, err := WorkspaceDir(root, ws)
	if err != nil {
		return "", err
	}
	if err := validateSegment("file_id", fileID); err != nil {
		return "", err
	}
	return filepath.Join(wd, "files", fileID), nil
}

func FileMetaPath(root string, ws Workspace, fileID string) (string, error) {
	fd, err := FileDir(root, ws, fileID)
	if err != nil {
		return "", err
	}
	return filepath.Join(fd, "meta.json"), nil
}

func SectionDir(root string, ws Workspace, fileID, sectionID string) (string, error) {
	fd, err := FileDir(root, ws, fileID)
	if err != nil {
		return "", err
	}
	if err := validateSegment("section_id", sectionID); err != nil {
		return "", err
	}
	return filepath.Join(fd, "sections", sectionID), nil
}

func SectionMetaPath(root string, ws Workspace, fileID, sectionID string) (string, error) {
	sd, err := SectionDir(root, ws, fileID, sectionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(sd, "meta.json"), nil
}

// contentRelPath is what SectionMeta.ContentFile stores (relative to the section dir).
func contentRelPath(contentHash string) string {
	return filepath.Join("content", contentHash+".md")
}

func ContentPath(root string, ws Workspace, fileID, sectionID, contentHash string) (string, error) {
	sd, err := SectionDir(root, ws, fileID, sectionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(sd, contentRelPath(contentHash)), nil
}

func MutationPath(root string, ws Workspace, mutationID string) (string, error) {
	wd, err := WorkspaceDir(root, ws)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(mutationID))
	return filepath.Join(wd, "mutations", hex.EncodeToString(sum[:])+".json"), nil
}
