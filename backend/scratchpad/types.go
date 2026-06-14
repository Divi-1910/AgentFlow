package scratchpad

const (
	LayoutVersion = 1

	OpCreate  = "create"
	OpAppend  = "append"
	OpReplace = "replace"

	// Storage caps
	DefaultMaxFilesPerWorkspace = 20
	DefaultMaxSectionsPerFile   = 50
	DefaultMaxSectionBytes      = 8 * 1024
	DefaultMaxWorkspaceBytes    = 1024 * 1024
	DefaultMaxTitleBytes        = 256
	DefaultMaxHeadingBytes      = 256
	MaxSegmentLen               = 128

	// Output caps (bound tool output, separate from storage)
	DefaultSearchLimit = 10
	MaxSearchLimit     = 50
	PreviewBytes       = 200
)

// Limits is injectable so tests can use small values.
type Limits struct {
	MaxFilesPerWorkspace int
	MaxSectionsPerFile   int
	MaxSectionBytes      int
	MaxWorkspaceBytes    int
	MaxTitleBytes        int
	MaxHeadingBytes      int
}

func (l Limits) withDefaults() Limits {
	if l.MaxFilesPerWorkspace <= 0 {
		l.MaxFilesPerWorkspace = DefaultMaxFilesPerWorkspace
	}
	if l.MaxSectionsPerFile <= 0 {
		l.MaxSectionsPerFile = DefaultMaxSectionsPerFile
	}
	if l.MaxSectionBytes <= 0 {
		l.MaxSectionBytes = DefaultMaxSectionBytes
	}
	if l.MaxWorkspaceBytes <= 0 {
		l.MaxWorkspaceBytes = DefaultMaxWorkspaceBytes
	}
	if l.MaxTitleBytes <= 0 {
		l.MaxTitleBytes = DefaultMaxTitleBytes
	}
	if l.MaxHeadingBytes <= 0 {
		l.MaxHeadingBytes = DefaultMaxHeadingBytes
	}
	return l
}

type Config struct {
	Root   string
	RGPath string
	Limits Limits
}

// Workspace identifies the shared collaboration workspace for one task tree.
type Workspace struct {
	UserID          string
	OriginatorRunID string
}

// FileMeta is files/{file_id}/meta.json. Written once at create; NEVER mutated
// by appends (section ordering lives on each section's meta as `ordinal`).
type FileMeta struct {
	SchemaVersion  int    `json:"schema_version"`
	FileID         string `json:"file_id"`
	Title          string `json:"title"`
	CreatedByAgent string `json:"created_by_agent_id"`
	CreatedByRunID string `json:"created_by_run_id"`
	CreatedAt      string `json:"created_at"`
}

// SectionMeta is files/{file_id}/sections/{section_id}/meta.json — the per-section
// COMMIT POINTER, written/renamed last. Its presence (and a content file whose
// hash matches) means the section is committed.
type SectionMeta struct {
	SchemaVersion     int    `json:"schema_version"`
	SectionID         string `json:"section_id"`
	FileID            string `json:"file_id"`
	Heading           string `json:"heading"`
	OwnerAgentID      string `json:"owner_agent_id"`
	Ordinal           int    `json:"ordinal"`
	ContentFile       string `json:"content_file"` // relative to the section dir: content/{hash}.md
	ContentHash       string `json:"content_hash"`
	SizeBytes         int    `json:"size_bytes"`
	Preview           string `json:"preview"`
	LastMutationID    string `json:"last_mutation_id"`
	CreatedByRunID    string `json:"created_by_run_id"`
	LastEditedByRunID string `json:"last_edited_by_run_id"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
}

// MutationLogEntry is mutations/{sha256(mutation_id)}.json — a convenience index
// for idempotency probes and audit. NOT the sole source of idempotency truth.
type MutationLogEntry struct {
	SchemaVersion int    `json:"schema_version"`
	MutationID    string `json:"mutation_id"`
	Op            string `json:"op"`
	FileID        string `json:"file_id"`
	SectionID     string `json:"section_id"`
	ContentHash   string `json:"content_hash"`
	At            string `json:"at"`
}

// ── Args / Results (RunID/ToolCallID set from ctx, not JSON) ──────────────────

type CreateArgs struct {
	Title      string `json:"title"`
	Heading    string `json:"heading"`
	Content    string `json:"content"`
	RunID      string `json:"-"`
	ToolCallID string `json:"-"`
}

type AppendArgs struct {
	FileID     string `json:"file_id"`
	Heading    string `json:"heading"`
	Content    string `json:"content"`
	RunID      string `json:"-"`
	ToolCallID string `json:"-"`
}

type ReplaceArgs struct {
	FileID       string `json:"file_id"`
	SectionID    string `json:"section_id"`
	Heading      string `json:"heading"`
	Content      string `json:"content"`
	ExpectedHash string `json:"expected_hash,omitempty"`
	RunID        string `json:"-"`
	ToolCallID   string `json:"-"`
}

type GetSectionsArgs struct {
	FileID string `json:"file_id"`
}

type ReadSectionArgs struct {
	FileID    string `json:"file_id"`
	SectionID string `json:"section_id"`
}

type SearchArgs struct {
	Pattern string `json:"pattern"`
	Limit   *int   `json:"limit,omitempty"`
}

type WriteResult struct {
	FileID       string `json:"file_id"`
	SectionID    string `json:"section_id"`
	Heading      string `json:"heading"`
	OwnerAgentID string `json:"owner_agent_id"`
	ContentHash  string `json:"content_hash"`
	Op           string `json:"op"`
	Created      bool   `json:"created"` // false on idempotent replay
}

type FileSummary struct {
	FileID         string `json:"file_id"`
	Title          string `json:"title"`
	CreatedByAgent string `json:"created_by_agent_id"`
	SectionCount   int    `json:"section_count"`
	SizeBytes      int    `json:"size_bytes"`
}

type ListResult struct {
	Files []FileSummary `json:"files"`
}

type SectionSummary struct {
	SectionID     string `json:"section_id"`
	Heading       string `json:"heading"`
	AuthorAgentID string `json:"author_agent_id"`
	Ordinal       int    `json:"ordinal"`
	SizeBytes     int    `json:"size_bytes"`
	ContentHash   string `json:"content_hash"`
	Preview       string `json:"preview"`
}

type GetSectionsResult struct {
	FileID   string           `json:"file_id"`
	Title    string           `json:"title"`
	Sections []SectionSummary `json:"sections"`
}

type ReadSectionResult struct {
	SectionID     string `json:"section_id"`
	Heading       string `json:"heading"`
	AuthorAgentID string `json:"author_agent_id"`
	Content       string `json:"content"`
	ContentHash   string `json:"content_hash"`
}

type SearchHit struct {
	FileID        string `json:"file_id"`
	SectionID     string `json:"section_id"`
	Heading       string `json:"heading"`
	AuthorAgentID string `json:"author_agent_id"`
	Snippet       string `json:"snippet"`
}

type SearchResult struct {
	Hits []SearchHit `json:"hits"`
}
