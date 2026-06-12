package agent

import (
	"backend/llm"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"
)

var supportedSnapshotVersions = []int{1}

const (
	PhasePreModel      = "pre_model"
	PhasePostModel     = "post_model"
	PhaseStepCompleted = "step.completed"
	PhaseWaitingJobs   = "waiting_for_jobs"
)

var ErrCheckpointStoreUnavailable = errors.New("checkpoint store unavailable")

type RunSnapshot struct {
	Version int          `json:"version"`
	RunID   string       `json:"run_id"`
	State   RuntimeState `json:"state"`
	Meta    SnapshotMeta `json:"meta"`
}

type RuntimeState struct {
	Messages       []llm.ChatMessage `json:"messages"`
	RawSummary     string            `json:"raw_summary"`
	StepsCompleted int               `json:"steps_completed"`
	MaxSteps       int               `json:"max_steps"`
	TotalUsage     llm.TokenUsage    `json:"total_usage"`
	ToolFailures   map[string]int    `json:"tool_failures"`
	PendingAwaits  []PendingAwait    `json:"pending_awaits,omitempty"`
}

type SnapshotMeta struct {
	AgentID        string  `json:"agent_id"`
	ThreadID       string  `json:"thread_id"`
	Provider       string  `json:"provider"`
	Model          string  `json:"model"`
	Temperature    float64 `json:"temperature"`
	ToolsetVersion string  `json:"toolset_version"` // sha256[:8] of the effective toolset
	// EffectiveTools is the full effective tool set at snapshot time (every
	// tool available to the run, not only those already invoked), with
	// per-tool structural + cosmetic identity for resume validation. The
	// json tag stays "tools_used" for back-compat; ToolRefList decodes both
	// the legacy []string shape and the new object shape.
	EffectiveTools     ToolRefList `json:"tools_used"`
	Attempt            int         `json:"attempt"`
	Phase              string      `json:"phase"`
	CheckpointFailures int         `json:"checkpoint_failures"`
	LastCheckpointAt   time.Time   `json:"last_checkpoint_at"`
	CreatedAt          time.Time   `json:"created_at"`

	// Delegation lineage (restored into RunContext on resume).
	OriginatorRunID string   `json:"originator_run_id,omitempty"`
	ParentRunID     string   `json:"parent_run_id,omitempty"`
	DelegationChain []string `json:"delegation_chain,omitempty"`
	DelegationDepth int      `json:"delegation_depth,omitempty"`
	InvocationKind  string   `json:"invocation_kind,omitempty"`
	JobID           string   `json:"job_id,omitempty"`
	SystemContext   string   `json:"system_context,omitempty"`
}

type CheckpointStore interface {
	CreateRun(ctx context.Context, runID, threadID, agentID, userID string) error
	Save(ctx context.Context, snapshot RunSnapshot) error
	LoadLatest(ctx context.Context, runID string) (*RunSnapshot, error)
	TransitionStatus(ctx context.Context, runID string, from, to string) (bool, error)
	TransitionStatusForUser(ctx context.Context, runID, userID string, from, to string) (bool, error)
	UpdateStatus(ctx context.Context, runID string, status string, lastError string) error
	IncrementAttempt(ctx context.Context, runID string) (int, error)
	GetRun(ctx context.Context, runID string) (*RunInfo, error)
	GetRunForUser(ctx context.Context, runID, userID string) (*RunInfo, error)
}

type RunInfo struct {
	RunID           string `json:"run_id"`
	ThreadID        string `json:"thread_id"`
	AgentID         string `json:"agent_id,omitempty"`
	UserID          string `json:"user_id,omitempty"`
	Status          string `json:"status"`
	Attempt         int    `json:"attempt"`
	StepsCompleted  int    `json:"steps_completed"`
	LastError       string `json:"last_error,omitempty"`
	OriginatorRunID string `json:"originator_run_id,omitempty"`
	ParentRunID     string `json:"parent_run_id,omitempty"`
	InvocationKind  string `json:"invocation_kind,omitempty"`
	JobID           string `json:"job_id,omitempty"`
}

func ValidateSnapshot(s *RunSnapshot, ts *ToolSet) error {
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
	if s.State.ToolFailures == nil {
		s.State.ToolFailures = make(map[string]int)
	}
	return CanResume(s.Meta, ts)
}

// CanResume is fatal when a recorded effective tool is missing from the current
// set or has changed structurally (name+params, or a delegate's target).
// Legacy snapshots (decoded from the old []string shape) carry no StructHash,
// so they fall back to a presence-only check.
func CanResume(meta SnapshotMeta, ts *ToolSet) error {
	current := make(map[string]ToolRef, len(ts.order))
	for _, r := range ts.Refs() {
		current[r.Name] = r
	}
	for _, used := range meta.EffectiveTools {
		cur, ok := current[used.Name]
		if !ok {
			return fmt.Errorf("tool %q is no longer available — cannot resume safely", used.Name)
		}
		if used.StructHash != "" && used.StructHash != cur.StructHash {
			return fmt.Errorf("tool %q changed structurally since checkpoint — cannot resume safely", used.Name)
		}
	}
	return nil
}

// ToolsetCosmeticWarning warns (never blocks) when a used tool's description or
// instructions drifted since the checkpoint — behaviour may differ but resume
// is safe.
func ToolsetCosmeticWarning(meta SnapshotMeta, ts *ToolSet) string {
	current := make(map[string]ToolRef, len(ts.order))
	for _, r := range ts.Refs() {
		current[r.Name] = r
	}
	var changed []string
	for _, used := range meta.EffectiveTools {
		cur, ok := current[used.Name]
		if !ok || used.CosmeticHash == "" {
			continue
		}
		if used.CosmeticHash != cur.CosmeticHash {
			changed = append(changed, used.Name)
		}
	}
	if len(changed) == 0 {
		return ""
	}
	return fmt.Sprintf("tool description/instructions changed since checkpoint for %v — resume proceeds, behaviour may differ", changed)
}

func ComputeToolsetVersion(ts *ToolSet) string {
	return ts.Version()
}

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
	if errors.Is(err, ErrCheckpointStoreUnavailable) {
		return true
	}
	return false
}

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
