package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"backend/llm"
	"backend/tools"
)

// supportedSnapshotVersions — reject any snapshot not in this list on resume.
var supportedSnapshotVersions = []int{1}

// -----------------------------------------------------------------------
// Snapshot Types
// -----------------------------------------------------------------------

// RunSnapshot is the durable runtime memory image at a step boundary.
type RunSnapshot struct {
	Version int          `json:"version"`
	RunID   string       `json:"run_id"`
	State   RuntimeState `json:"state"`
	Meta    SnapshotMeta `json:"meta"`
}

// RuntimeState is everything needed to reconstruct the execution loop.
// The system message is NOT stored here — it is regenerated on resume via
// BuildSystemMessage(agent.SystemPrompt, State.RawSummary) to avoid drift.
type RuntimeState struct {
	// Messages holds the full conversation so far — excludes the system message.
	Messages       []llm.ChatMessage `json:"messages"`
	RawSummary     string            `json:"raw_summary"`
	StepsCompleted int               `json:"steps_completed"`
	MaxSteps       int               `json:"max_steps"`
	TotalUsage     llm.TokenUsage   `json:"total_usage"`
	ToolFailures   map[string]int   `json:"tool_failures"`
}

// SnapshotMeta captures the execution environment — needed for resume safety checks.
type SnapshotMeta struct {
	AgentID            string    `json:"agent_id"`
	ThreadID           string    `json:"thread_id"`
	Provider           string    `json:"provider"`
	Model              string    `json:"model"`
	Temperature        float64   `json:"temperature"`
	ToolsetVersion     string    `json:"toolset_version"` // sha256[:8] of sorted tool names
	ToolsUsed          []string  `json:"tools_used"`      // tool names present at snapshot time
	Attempt            int       `json:"attempt"`
	Phase              string    `json:"phase"`
	CheckpointFailures int       `json:"checkpoint_failures"`
	LastCheckpointAt   time.Time `json:"last_checkpoint_at"`
	CreatedAt          time.Time `json:"created_at"`
}



// CheckpointStore is the persistence boundary for run state.
// MongoCheckpointStore implements this.
type CheckpointStore interface {
	CreateRun(ctx context.Context, runID, threadID, agentID, userID string) error
	Save(ctx context.Context, snapshot RunSnapshot) error
	LoadLatest(ctx context.Context, runID string) (*RunSnapshot, error)

	// TransitionStatus atomically claims ownership (prevents dual-resume).
	// Returns true only if FROM status matched and was updated.
	TransitionStatus(ctx context.Context, runID string, from, to string) (bool, error)
	UpdateStatus(ctx context.Context, runID string, status string, lastError string) error
	IncrementAttempt(ctx context.Context, runID string) (int, error)
	GetRun(ctx context.Context, runID string) (*RunInfo, error)
}

// RunInfo is a lightweight read-only run state (returned by GET /runs/:id).
type RunInfo struct {
	RunID          string `json:"run_id"`
	ThreadID       string `json:"thread_id"`
	Status         string `json:"status"`
	Attempt        int    `json:"attempt"`
	StepsCompleted int    `json:"steps_completed"`
	LastError      string `json:"last_error,omitempty"`
}

// -----------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------

// ValidateSnapshot verifies integrity before handing a snapshot to the runtime.
func ValidateSnapshot(s *RunSnapshot, registry *tools.ToolRegistry) error {
	if s == nil {
		return errors.New("snapshot is nil")
	}
	if !slices.Contains(supportedSnapshotVersions, s.Version) {
		return fmt.Errorf("unsupported snapshot version %d (supported: %v)", s.Version, supportedSnapshotVersions)
	}
	if s.RunID == "" {
		return errors.New("snapshot missing run_id")
	}
	if len(s.State.Messages) == 0 {
		return errors.New("snapshot has empty message history")
	}
	if s.State.StepsCompleted < 0 {
		return fmt.Errorf("snapshot step counter negative: %d", s.State.StepsCompleted)
	}
	if s.State.MaxSteps > 0 && s.State.StepsCompleted > s.State.MaxSteps {
		return fmt.Errorf("snapshot step counter exceeds max: steps=%d max=%d", s.State.StepsCompleted, s.State.MaxSteps)
	}
	// Nil-safe toolFailures
	if s.State.ToolFailures == nil {
		s.State.ToolFailures = make(map[string]int)
	}
	return CanResume(s.Meta, registry)
}

// CanResume verifies the current tool registry is compatible with the snapshot.
func CanResume(meta SnapshotMeta, registry *tools.ToolRegistry) error {
	for _, toolName := range meta.ToolsUsed {
		if !registry.Has(toolName) {
			return fmt.Errorf("tool %q is no longer registered — cannot resume safely", toolName)
		}
	}
	current := ComputeToolsetVersion(registry)
	if current != meta.ToolsetVersion {
		// Version drift is a warning, not an error, as long as all tools still exist.
		// The caller will log this.
	}
	return nil
}

// ComputeToolsetVersion returns a short deterministic hash of registered tool names.
func ComputeToolsetVersion(registry *tools.ToolRegistry) string {
	names := registry.Names()
	// Names() already returns unsorted; sort deterministically
	sorted := make([]string, len(names))
	copy(sorted, names)
	slices.Sort(sorted)
	h := sha256.Sum256([]byte(strings.Join(sorted, ",")))
	return hex.EncodeToString(h[:4])
}

// -----------------------------------------------------------------------
// Resume Eligibility
// -----------------------------------------------------------------------

// IsResumable classifies whether a run error permits resume.
// Transient infrastructure failures are resumable; logic/config failures are not.
func IsResumable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	// Checkpoint store unavailability is resumable (infrastructure, not logic)
	if strings.Contains(err.Error(), "checkpoint store unavailable") {
		return true
	}
	return false
}

// -----------------------------------------------------------------------
// Compression
// -----------------------------------------------------------------------

// CompressSnapshot serializes and gzip-compresses a snapshot for storage.
func CompressSnapshot(s RunSnapshot) ([]byte, error) {
	raw, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("snapshot marshal: %w", err)
	}
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(raw); err != nil {
		return nil, fmt.Errorf("snapshot compress write: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("snapshot compress close: %w", err)
	}
	return buf.Bytes(), nil
}

// DecompressSnapshot decompresses and deserializes a stored snapshot.
func DecompressSnapshot(data []byte) (*RunSnapshot, error) {
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("snapshot decompress open: %w", err)
	}
	defer r.Close()
	var s RunSnapshot
	if err := json.NewDecoder(r).Decode(&s); err != nil {
		return nil, fmt.Errorf("snapshot decompress decode: %w", err)
	}
	return &s, nil
}
