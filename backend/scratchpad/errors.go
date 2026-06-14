package scratchpad

import "errors"

var (
	ErrInvalidArgs       = errors.New("invalid scratchpad arguments")
	ErrInvalidName       = errors.New("invalid scratchpad path segment")
	ErrFileNotFound      = errors.New("scratchpad file not found")
	ErrSectionNotFound   = errors.New("scratchpad section not found")
	ErrNotOwner          = errors.New("scratchpad section is owned by another agent")
	ErrHashMismatch      = errors.New("expected_hash does not match current section")
	ErrMutationConflict  = errors.New("mutation id reused for a different operation or target")
	ErrCorruptSection    = errors.New("scratchpad section content failed integrity check")
	ErrMutationIDMissing = errors.New("scratchpad mutation id requires run_id and tool_call_id")

	// Caps
	ErrMaxFiles          = errors.New("scratchpad workspace file limit reached")
	ErrMaxSections       = errors.New("scratchpad file section limit reached")
	ErrSectionTooLarge   = errors.New("scratchpad section exceeds max size")
	ErrWorkspaceTooLarge = errors.New("scratchpad workspace exceeds max size")
	ErrTitleTooLong      = errors.New("scratchpad title exceeds max length")
	ErrHeadingTooLong    = errors.New("scratchpad heading exceeds max length")
)
