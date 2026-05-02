package agent

import (
	"backend/llm"
	"backend/tools"
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
)

var supportedSnapshotVersions = []int{1}

const (
	PhasePreModel      = "pre_model"
	PhasePostModel     = "post_model"
	PhaseStepCompleted = "step.completed"
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
}

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
	RunID          string `json:"run_id"`
	ThreadID       string `json:"thread_id"`
	AgentID        string `json:"agent_id,omitempty"`
	UserID         string `json:"user_id,omitempty"`
	Status         string `json:"status"`
	Attempt        int    `json:"attempt"`
	StepsCompleted int    `json:"steps_completed"`
	LastError      string `json:"last_error,omitempty"`
}

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
	if s.State.ToolFailures == nil {
		s.State.ToolFailures = make(map[string]int)
	}
	return CanResume(s.Meta, registry)
}

func CanResume(meta SnapshotMeta, registry *tools.ToolRegistry) error {
	for _, toolName := range meta.ToolsUsed {
		if !registry.Has(toolName) {
			return fmt.Errorf("tool %q is no longer registered — cannot resume safely", toolName)
		}
	}
	return nil
}

func ToolsetVersionWarning(meta SnapshotMeta, registry *tools.ToolRegistry) string {
	if meta.ToolsetVersion == "" {
		return "" // pre-versioning snapshot; no baseline to compare against
	}
	current := ComputeToolsetVersion(registry)
	if current == meta.ToolsetVersion {
		return ""
	}
	return fmt.Sprintf(
		"toolset version changed since checkpoint (snapshot=%s current=%s tools_used=%v) — resume proceeds but tool behaviour may differ",
		meta.ToolsetVersion, current, meta.ToolsUsed,
	)
}

func ComputeToolsetVersion(registry *tools.ToolRegistry) string {
	defs := registry.Definitions()
	var sb strings.Builder
	for _, d := range defs {
		sb.WriteString(d.Name)
		sb.WriteByte(':')
		sb.Write(d.Parameters)
		sb.WriteByte('\n')
	}
	h := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(h[:4])
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
