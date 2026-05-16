package agent

import (
	"context"
	"errors"
	"testing"

	"backend/llm"
	"backend/tools"
)


// minimalSnapshot returns a valid snapshot that can be tweaked per test.
func minimalSnapshot() RunSnapshot {
	return RunSnapshot{
		Version: 1,
		RunID:   "run-001",
		State: RuntimeState{
			Messages:       []llm.ChatMessage{{Role: "user", Content: "hello"}},
			StepsCompleted: 1,
			MaxSteps:       10,
			ToolFailures:   map[string]int{},
		},
		Meta: SnapshotMeta{},
	}
}

// registryWith returns a registry containing exactly the provided tools.
func registryWith(ts ...tools.Tool) *tools.ToolRegistry {
	r := tools.NewEmptyRegistry()
	for _, t := range ts {
		r.Register(t)
	}
	return r
}

// ── CompressSnapshot / DecompressSnapshot ────────────────────────────────────

func TestSnapshotRoundTripPreservesAllFields(t *testing.T) {
	t.Parallel()
	original := RunSnapshot{
		Version: 1,
		RunID:   "run-abc",
		State: RuntimeState{
			Messages: []llm.ChatMessage{
				{Role: "user", Content: "what is 2+2?"},
				{Role: "assistant", Content: "It is 4."},
			},
			StepsCompleted: 2,
			MaxSteps:       25,
			ToolFailures:   map[string]int{"calculator": 1},
		},
		Meta: SnapshotMeta{
			AgentID:  "agent-1",
			ThreadID: "thread-1",
			Phase:    PhaseStepCompleted,
		},
	}

	compressed, err := CompressSnapshot(original)
	if err != nil {
		t.Fatalf("CompressSnapshot: %v", err)
	}

	recovered, err := DecompressSnapshot(compressed)
	if err != nil {
		t.Fatalf("DecompressSnapshot: %v", err)
	}

	if recovered.Version != original.Version {
		t.Errorf("Version: got %d, want %d", recovered.Version, original.Version)
	}
	if recovered.RunID != original.RunID {
		t.Errorf("RunID: got %q, want %q", recovered.RunID, original.RunID)
	}
	if recovered.Meta.Phase != original.Meta.Phase {
		t.Errorf("Phase: got %q, want %q", recovered.Meta.Phase, original.Meta.Phase)
	}
	if len(recovered.State.Messages) != len(original.State.Messages) {
		t.Errorf("Messages: got %d, want %d", len(recovered.State.Messages), len(original.State.Messages))
	}
	if recovered.State.ToolFailures["calculator"] != 1 {
		t.Errorf("ToolFailures[calculator]: got %d, want 1", recovered.State.ToolFailures["calculator"])
	}
}

func TestDecompressSnapshotRejectsGarbageData(t *testing.T) {
	t.Parallel()
	_, err := DecompressSnapshot([]byte("this is not gzip"))
	if err == nil {
		t.Fatal("DecompressSnapshot: want error for garbage input, got nil")
	}
}

// ── ValidateSnapshot ─────────────────────────────────────────────────────────

func TestValidateSnapshot(t *testing.T) {
	t.Parallel()

	registry := registryWith(tools.NewCalculatorTool())

	t.Run("returns error for nil snapshot", func(t *testing.T) {
		t.Parallel()
		if err := ValidateSnapshot(nil, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("returns error for unsupported version", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.Version = 99
		if err := ValidateSnapshot(&s, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("returns error when run_id is empty", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.RunID = ""
		if err := ValidateSnapshot(&s, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("returns error when message history is empty", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.State.Messages = nil
		if err := ValidateSnapshot(&s, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("returns error when steps completed is negative", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.State.StepsCompleted = -1
		if err := ValidateSnapshot(&s, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("returns error when steps completed exceeds max", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.State.StepsCompleted = 15
		s.State.MaxSteps = 10
		if err := ValidateSnapshot(&s, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("returns error when a required tool is no longer registered", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.Meta.ToolsUsed = []string{"removed_tool"}
		if err := ValidateSnapshot(&s, registry); err == nil {
			t.Fatal("want error, got nil")
		}
	})

	t.Run("initialises nil ToolFailures map as side effect", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.State.ToolFailures = nil
		_ = ValidateSnapshot(&s, registry)
		if s.State.ToolFailures == nil {
			t.Error("want ToolFailures initialised to empty map, got nil")
		}
	})

	t.Run("returns nil for a fully valid snapshot", func(t *testing.T) {
		t.Parallel()
		s := minimalSnapshot()
		s.Meta.ToolsUsed = []string{"calculator"}
		if err := ValidateSnapshot(&s, registry); err != nil {
			t.Fatalf("want nil error, got: %v", err)
		}
	})
}

// ── CanResume ─────────────────────────────────────────────────────────────────

func TestCanResumeReturnsNilWhenToolsUsedIsEmpty(t *testing.T) {
	t.Parallel()
	registry := tools.NewEmptyRegistry()
	meta := SnapshotMeta{ToolsUsed: nil}
	if err := CanResume(meta, registry); err != nil {
		t.Fatalf("want nil, got: %v", err)
	}
}

func TestCanResumeReturnsNilWhenAllToolsArePresent(t *testing.T) {
	t.Parallel()
	registry := registryWith(tools.NewCalculatorTool())
	meta := SnapshotMeta{ToolsUsed: []string{"calculator"}}
	if err := CanResume(meta, registry); err != nil {
		t.Fatalf("want nil, got: %v", err)
	}
}

func TestCanResumeReturnsErrorForRemovedTool(t *testing.T) {
	t.Parallel()
	registry := tools.NewEmptyRegistry() // "removed_tool" is not registered
	meta := SnapshotMeta{ToolsUsed: []string{"removed_tool"}}
	err := CanResume(meta, registry)
	if err == nil {
		t.Fatal("want error for missing tool, got nil")
	}
}

// ── IsResumable ───────────────────────────────────────────────────────────────

func TestIsResumable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil error is not resumable", err: nil, want: false},
		{name: "context.Canceled is resumable", err: context.Canceled, want: true},
		{name: "context.DeadlineExceeded is resumable", err: context.DeadlineExceeded, want: true},
		{name: "ErrCheckpointStoreUnavailable is resumable", err: ErrCheckpointStoreUnavailable, want: true},
		{name: "wrapped ErrCheckpointStoreUnavailable is resumable", err: errors.Join(errors.New("outer"), ErrCheckpointStoreUnavailable), want: true},
		{name: "generic error is not resumable", err: errors.New("something went wrong"), want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := IsResumable(tc.err)
			if got != tc.want {
				t.Errorf("IsResumable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// ── ComputeToolsetVersion ────────────────────────────────────────────────────

func TestComputeToolsetVersionIsDeterministic(t *testing.T) {
	t.Parallel()
	r := registryWith(tools.NewCalculatorTool())
	v1 := ComputeToolsetVersion(r)
	v2 := ComputeToolsetVersion(r)
	if v1 != v2 {
		t.Errorf("got different versions on two calls: %q vs %q", v1, v2)
	}
}

func TestComputeToolsetVersionIs8HexChars(t *testing.T) {
	t.Parallel()
	r := tools.NewEmptyRegistry()
	v := ComputeToolsetVersion(r)
	if len(v) != 8 {
		t.Errorf("version length: got %d, want 8 (got %q)", len(v), v)
	}
}

func TestComputeToolsetVersionChangesWhenToolIsAdded(t *testing.T) {
	t.Parallel()
	rCalc := registryWith(tools.NewCalculatorTool())
	rBoth := registryWith(tools.NewCalculatorTool(), tools.NewHTTPTool(0, nil))

	vCalc := ComputeToolsetVersion(rCalc)
	vBoth := ComputeToolsetVersion(rBoth)

	if vCalc == vBoth {
		t.Errorf("expected different versions after adding a tool, both are %q", vCalc)
	}
}

// ── ToolsetVersionWarning ────────────────────────────────────────────────────

func TestToolsetVersionWarningReturnsEmptyWhenVersionsMatch(t *testing.T) {
	t.Parallel()
	r := registryWith(tools.NewCalculatorTool())
	current := ComputeToolsetVersion(r)
	meta := SnapshotMeta{ToolsetVersion: current}
	if w := ToolsetVersionWarning(meta, r); w != "" {
		t.Errorf("want empty warning, got %q", w)
	}
}

func TestToolsetVersionWarningReturnsMessageWhenVersionsDiffer(t *testing.T) {
	t.Parallel()
	r := registryWith(tools.NewCalculatorTool())
	meta := SnapshotMeta{ToolsetVersion: "deadbeef"} // stale version
	w := ToolsetVersionWarning(meta, r)
	if w == "" {
		t.Error("want non-empty warning for version mismatch, got empty string")
	}
}

func TestToolsetVersionWarningReturnsEmptyForPreVersioningSnapshot(t *testing.T) {
	t.Parallel()
	r := registryWith(tools.NewCalculatorTool())
	meta := SnapshotMeta{ToolsetVersion: ""} // snapshot predates versioning
	if w := ToolsetVersionWarning(meta, r); w != "" {
		t.Errorf("want empty warning for empty baseline, got %q", w)
	}
}
