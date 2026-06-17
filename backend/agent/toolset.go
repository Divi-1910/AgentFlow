package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"backend/llm"
	"backend/tools"
)

// ErrToolConfig is returned when an agent's effective tool set is misconfigured
// (name collisions, delegates without an invoker, etc.).
var ErrToolConfig = errors.New("invalid tool configuration")

type toolKind int

const (
	toolKindRegular toolKind = iota
	toolKindDelegate
	toolKindAsync
	toolKindMCP
)

// ToolRef is the per-tool identity recorded in a snapshot for resume checks.
// StructHash captures resume-fatal identity (name + params + delegate target);
// CosmeticHash captures resume-warn identity (description + instructions).
type ToolRef struct {
	Name         string `json:"name"`
	StructHash   string `json:"struct_hash,omitempty"`
	CosmeticHash string `json:"cosmetic_hash,omitempty"`
}

// ToolRefList decodes both the legacy []string (tools_used) snapshot shape and
// the new []ToolRef object shape, so old snapshots still resume.
type ToolRefList []ToolRef

func (l *ToolRefList) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*l = nil
		return nil
	}
	// New shape: array of objects.
	var refs []ToolRef
	if err := json.Unmarshal(data, &refs); err == nil {
		*l = refs
		return nil
	}
	// Legacy shape: array of strings → name-only refs (presence-checked only).
	var names []string
	if err := json.Unmarshal(data, &names); err != nil {
		return fmt.Errorf("toolref: unrecognized tools_used shape: %w", err)
	}
	out := make([]ToolRef, len(names))
	for i, n := range names {
		out[i] = ToolRef{Name: n}
	}
	*l = out
	return nil
}

// ToolSet is the effective tool universe for a single run: registry tools the
// agent has plus synthesized delegate tools. Every consumer (LLM definitions,
// execution, prompt instructions, snapshot/version, resume validation) reads
// from one ToolSet so the run sees a single consistent tool surface.
type ToolSet struct {
	order []string
	tools map[string]tools.Tool
	kinds map[string]toolKind
}

func newToolSet() *ToolSet {
	return &ToolSet{tools: map[string]tools.Tool{}, kinds: map[string]toolKind{}}
}

func (ts *ToolSet) add(name string, t tools.Tool, kind toolKind) {
	ts.order = append(ts.order, name)
	ts.tools[name] = t
	ts.kinds[name] = kind
}

func (ts *ToolSet) Has(name string) bool { _, ok := ts.tools[name]; return ok }

func (ts *ToolSet) Get(name string) (tools.Tool, bool) {
	t, ok := ts.tools[name]
	return t, ok
}

func (ts *ToolSet) DelegateTarget(name string) (string, bool) {
	if ts.kinds[name] != toolKindDelegate {
		return "", false
	}
	dt, ok := ts.tools[name].(*delegateTool)
	if !ok {
		return "", false
	}
	return dt.cfg.AgentID, true
}

func (ts *ToolSet) Names() []string {
	out := make([]string, len(ts.order))
	copy(out, ts.order)
	return out
}

func (ts *ToolSet) Definitions() []llm.ToolDefinition {
	defs := make([]llm.ToolDefinition, 0, len(ts.order))
	for _, n := range ts.order {
		defs = append(defs, ts.tools[n].Definition())
	}
	return defs
}

// Refs returns per-tool identity for every effective tool, for snapshotting
// and resume validation.
func (ts *ToolSet) Refs() []ToolRef {
	refs := make([]ToolRef, 0, len(ts.order))
	for _, n := range ts.order {
		if ts.kinds[n] == toolKindMCP {
			continue // MCP tools are NOT part of the resume identity (see AddMCPTools)
		}
		refs = append(refs, ts.refFor(n))
	}
	return refs
}

// Version is a stable whole-set structural digest (used for the snapshot's
// ToolsetVersion quick-compare). Per-tool checks in CanResume are the
// authoritative resume gate.
func (ts *ToolSet) Version() string {
	parts := make([]string, 0, len(ts.order))
	for _, n := range ts.order {
		if ts.kinds[n] == toolKindMCP {
			continue // excluded from the resume identity, like Refs()
		}
		r := ts.refFor(n)
		parts = append(parts, r.Name+":"+r.StructHash)
	}
	sort.Strings(parts)
	return hashParts(parts...)
}

func (ts *ToolSet) refFor(name string) ToolRef {
	def := ts.tools[name].Definition()
	cosmetic := hashParts(def.Description, def.Instructions)
	if ts.kinds[name] == toolKindDelegate {
		target := ""
		if dt, ok := ts.tools[name].(*delegateTool); ok {
			target = dt.cfg.AgentID
		}
		return ToolRef{
			Name:         name,
			StructHash:   hashParts("delegate", name, target, string(def.Parameters)),
			CosmeticHash: cosmetic,
		}
	}
	return ToolRef{
		Name:         name,
		StructHash:   hashParts("tool", name, string(def.Parameters)),
		CosmeticHash: cosmetic,
	}
}

func hashParts(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(h[:8])
}

// BuildToolSet constructs the execution-mode tool set: registry tools + live
// delegate tools. Fails if a delegate is configured but no invoker is supplied,
// or on any name collision across the effective set.
func BuildToolSet(reg *tools.ToolRegistry, inv DelegateInvoker, ag *Agent, asyncStores ...AsyncJobStore) (*ToolSet, error) {
	var asyncStore AsyncJobStore
	if len(asyncStores) > 0 {
		asyncStore = asyncStores[0]
	}
	return buildToolSet(reg, inv, asyncStore, ag, false)
}

// BuildToolSetForValidation constructs a definition-only tool set (delegate
// tools carry a nil invoker). Used by resume preflight, which only needs
// names/params/identity, never execution.
func BuildToolSetForValidation(reg *tools.ToolRegistry, ag *Agent) (*ToolSet, error) {
	return buildToolSet(reg, nil, nil, ag, true)
}

// AddMCPTools merges discovered MCP tools into the set for LLM definitions and
// execution ONLY. They are deliberately EXCLUDED from Refs()/Version() (the
// resume identity), so an MCP server being down or schema-drifted on resume can
// never block a resume — it just re-discovers fresh. Collisions are skipped,
// never fatal (degrade, don't fail). Called after BuildToolSet at run start.
func (ts *ToolSet) AddMCPTools(mcpTools []tools.Tool) {
	for _, t := range mcpTools {
		if t == nil || ts.Has(t.Name()) {
			continue
		}
		ts.add(t.Name(), t, toolKindMCP)
	}
}

func buildToolSet(reg *tools.ToolRegistry, inv DelegateInvoker, asyncStore AsyncJobStore, ag *Agent, validation bool) (*ToolSet, error) {
	ts := newToolSet()

	for _, name := range ag.Tools {
		if ts.Has(name) {
			return nil, fmt.Errorf("%w: duplicate tool %q", ErrToolConfig, name)
		}
		t, err := reg.Get(name)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrToolNotAvailable, name)
		}
		ts.add(name, t, toolKindRegular)
	}

	if len(ag.Delegates) > 0 && !validation && inv == nil {
		return nil, fmt.Errorf("%w: agent %q has delegates but no delegate invoker is configured", ErrToolConfig, ag.ID)
	}

	for _, d := range ag.Delegates {
		if d.ToolName == AsyncToolDispatchAgent || d.ToolName == AsyncToolAwaitJob {
			return nil, fmt.Errorf("%w: delegate tool name %q is reserved", ErrToolConfig, d.ToolName)
		}
		if ts.Has(d.ToolName) {
			return nil, fmt.Errorf("%w: delegate tool name %q collides with another tool or delegate", ErrToolConfig, d.ToolName)
		}
		// Also reject collisions with the global registry even when the agent
		// doesn't list that tool: a delegate named after any registered tool
		// (e.g. "calculator") would shadow it confusingly. The API validates
		// this too; this is runtime defense-in-depth.
		if reg.Has(d.ToolName) {
			return nil, fmt.Errorf("%w: delegate tool name %q collides with a registered tool", ErrToolConfig, d.ToolName)
		}
		ts.add(d.ToolName, newDelegateTool(d, inv), toolKindDelegate)
	}

	if len(ag.Delegates) > 0 {
		if ts.Has(AsyncToolDispatchAgent) || reg.Has(AsyncToolDispatchAgent) {
			return nil, fmt.Errorf("%w: async tool name %q collides with another tool", ErrToolConfig, AsyncToolDispatchAgent)
		}
		if ts.Has(AsyncToolAwaitJob) || reg.Has(AsyncToolAwaitJob) {
			return nil, fmt.Errorf("%w: async tool name %q collides with another tool", ErrToolConfig, AsyncToolAwaitJob)
		}
		ts.add(AsyncToolDispatchAgent, newDispatchAgentTool(ts, asyncStore), toolKindAsync)
		ts.add(AsyncToolAwaitJob, newAwaitJobTool(asyncStore), toolKindAsync)
	}

	return ts, nil
}
