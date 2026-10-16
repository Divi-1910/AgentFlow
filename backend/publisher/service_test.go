package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/deployment"
	"backend/mcp"
	"backend/tools"
)

type fakeAgentReader struct {
	mu     sync.Mutex
	agents map[string]*agent.Agent
	calls  map[string]int
	getFn  func(agentID string, call int) (*agent.Agent, error)
}

func (r *fakeAgentReader) GetByID(_ context.Context, agentID, _ string) (*agent.Agent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.calls == nil {
		r.calls = make(map[string]int)
	}
	r.calls[agentID]++
	if r.getFn != nil {
		return r.getFn(agentID, r.calls[agentID])
	}
	a, ok := r.agents[agentID]
	if !ok {
		return nil, fmt.Errorf("agent not found")
	}
	return cloneTestAgent(a), nil
}

func cloneTestAgent(a *agent.Agent) *agent.Agent {
	copy := *a
	copy.Tools = append([]string(nil), a.Tools...)
	copy.Delegates = append([]agent.DelegateConfig(nil), a.Delegates...)
	copy.MCPServers = append([]agent.MCPServerSelection(nil), a.MCPServers...)
	copy.MCPConnections = append([]agent.MCPServerConnection(nil), a.MCPConnections...)
	return &copy
}

type fakeMCPServerCatalog struct {
	entries map[string]mcp.CatalogEntry
	err     error
}

func (f fakeMCPServerCatalog) GetEnabledByIDs(_ context.Context, serverIDs []string) (map[string]mcp.CatalogEntry, error) {
	if f.err != nil {
		return nil, f.err
	}
	result := make(map[string]mcp.CatalogEntry, len(serverIDs))
	for _, serverID := range serverIDs {
		if f.entries != nil {
			if entry, exists := f.entries[serverID]; exists {
				result[serverID] = entry
			}
			continue
		}
		result[serverID] = mcp.CatalogEntry{
			ServerID: serverID, Name: serverID, Alias: serverID,
			DeploymentURL: "http://" + serverID + ".mcp-system.svc.cluster.local/mcp", Enabled: true,
		}
	}
	return result, nil
}

type fakeRevisionStore struct {
	mu          sync.Mutex
	inputs      []deployment.RevisionInput
	wasExisting bool
	appendErr   error
	revision    *deployment.Revision
}

func (s *fakeRevisionStore) Append(_ context.Context, input deployment.RevisionInput) (*deployment.Revision, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.BundleJSON = append([]byte(nil), input.BundleJSON...)
	s.inputs = append(s.inputs, input)
	if s.appendErr != nil {
		return nil, false, s.appendErr
	}
	if s.revision != nil {
		copy := *s.revision
		copy.BundleJSON = append([]byte(nil), s.revision.BundleJSON...)
		return &copy, s.wasExisting, nil
	}
	return &deployment.Revision{
		UserID: input.UserID, DeploymentID: input.DeploymentID, RootAgentID: input.RootAgentID,
		Revision: 1, IdempotencyKey: input.IdempotencyKey, SourceRevision: input.SourceRevision,
		ConfigHash: input.ConfigHash, SchemaVersion: input.SchemaVersion,
		BundleJSON: append([]byte(nil), input.BundleJSON...), CreatedAt: time.Unix(1, 0).UTC(),
	}, s.wasExisting, nil
}

func (s *fakeRevisionStore) Get(context.Context, string, string, int) (*deployment.Revision, error) {
	if s.revision == nil {
		return nil, deployment.ErrRevisionNotFound
	}
	copy := *s.revision
	copy.BundleJSON = append([]byte(nil), s.revision.BundleJSON...)
	return &copy, nil
}

func (s *fakeRevisionStore) List(context.Context, string, string, int) ([]deployment.Revision, error) {
	if s.revision == nil {
		return []deployment.Revision{}, nil
	}
	return []deployment.Revision{*s.revision}, nil
}

func validAgent(id string) *agent.Agent {
	return &agent.Agent{
		ID: id, Name: id, Provider: "openai", Model: "gpt-4o", SystemPrompt: "prompt",
		ModelContextLimit: 128000, ContextWindow: 6, ContextKeepRatio: .5,
		MaxSteps: 10, Temperature: .7, MaxTokens: 100, MaxRuns: 10,
	}
}

func newTestService(t *testing.T, reader AgentReader, store RevisionStore, attempts int) *Service {
	t.Helper()
	svc, err := NewService(Config{
		Agents: reader, Revisions: store, Platform: &agent.PlatformConfig{Body: "<platform>publish</platform>"},
		Catalog: tools.NewCatalogRegistry(), MCPServers: fakeMCPServerCatalog{}, SnapshotAttempts: attempts,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func TestPublishWalksSortsFreezesAndRoundTrips(t *testing.T) {
	root := validAgent("root")
	root.ContextWindow = 0
	root.Delegates = []agent.DelegateConfig{
		{AgentID: "worker-z", ToolName: "ask_z"},
		{AgentID: "worker-a", ToolName: "ask_a"},
	}
	workerZ := validAgent("worker-z")
	workerZ.Delegates = []agent.DelegateConfig{{AgentID: "shared", ToolName: "ask_shared_z"}}
	workerA := validAgent("worker-a")
	workerA.Delegates = []agent.DelegateConfig{{AgentID: "shared", ToolName: "ask_shared_a"}}
	shared := validAgent("shared")
	reader := &fakeAgentReader{agents: map[string]*agent.Agent{
		"root": root, "worker-z": workerZ, "worker-a": workerA, "shared": shared,
	}}
	store := &fakeRevisionStore{}
	result, err := newTestService(t, reader, store, 0).Publish(context.Background(), "user", "root", "publish-walk")
	if err != nil {
		t.Fatal(err)
	}
	if result.WasExisting || result.Revision.Revision != 1 {
		t.Fatalf("result = %+v", result)
	}
	bundle, err := deployment.Parse(result.Revision.BundleJSON)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(bundle.Agents))
	for i, a := range bundle.Agents {
		ids[i] = a.ID
	}
	if want := []string{"root", "shared", "worker-a", "worker-z"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("agent order = %v, want %v", ids, want)
	}
	if bundle.Agents[0].Delegates[0].AgentID != "worker-z" || bundle.Agents[0].ContextWindow != agent.DefaultContextWindow {
		t.Fatalf("authored order/default not preserved: %+v", bundle.Agents[0])
	}
	if bundle.PlatformXML != "<platform>publish</platform>" || bundle.DeploymentID != "root" {
		t.Fatalf("bundle identity/platform = %+v", bundle)
	}
	if reader.calls["shared"] != 2 {
		t.Fatalf("shared agent loads = %d, want one walk + one verification", reader.calls["shared"])
	}
	if len(store.inputs) != 1 || store.inputs[0].IdempotencyKey != "publish-walk" {
		t.Fatalf("revision input = %+v", store.inputs)
	}
}

func TestPublishRetriesUnstableSnapshotThenSucceeds(t *testing.T) {
	reader := &fakeAgentReader{getFn: func(id string, call int) (*agent.Agent, error) {
		a := validAgent(id)
		if call == 1 {
			a.SystemPrompt = "first"
		} else {
			a.SystemPrompt = "stable"
		}
		return a, nil
	}}
	store := &fakeRevisionStore{}
	if _, err := newTestService(t, reader, store, 3).Publish(context.Background(), "user", "root", "snapshot-retry"); err != nil {
		t.Fatal(err)
	}
	if reader.calls["root"] != 4 || len(store.inputs) != 1 {
		t.Fatalf("calls/writes = %d/%d, want 4/1", reader.calls["root"], len(store.inputs))
	}
}

func TestPublishRejectsInvalidIdempotencyKeyBeforeReadingGraph(t *testing.T) {
	reader := &fakeAgentReader{agents: map[string]*agent.Agent{"root": validAgent("root")}}
	store := &fakeRevisionStore{}
	_, err := newTestService(t, reader, store, 0).Publish(context.Background(), "user", "root", "contains space")
	if !errors.Is(err, deployment.ErrRevisionIdempotencyKey) {
		t.Fatalf("Publish error = %v", err)
	}
	if len(reader.calls) != 0 || len(store.inputs) != 0 {
		t.Fatalf("reader calls/revision writes = %v/%d", reader.calls, len(store.inputs))
	}
}

func TestPublishRejectsContinuouslyChangingSnapshot(t *testing.T) {
	reader := &fakeAgentReader{getFn: func(id string, call int) (*agent.Agent, error) {
		a := validAgent(id)
		a.SystemPrompt = fmt.Sprintf("prompt-%d", call)
		return a, nil
	}}
	store := &fakeRevisionStore{}
	_, err := newTestService(t, reader, store, 3).Publish(context.Background(), "user", "root", "unstable")
	if !errors.Is(err, ErrGraphUnstable) {
		t.Fatalf("Publish error = %v", err)
	}
	if reader.calls["root"] != 6 || len(store.inputs) != 0 {
		t.Fatalf("calls/writes = %d/%d, want 6/0", reader.calls["root"], len(store.inputs))
	}
}

func TestPublishRejectsMissingRootChildAndCycle(t *testing.T) {
	t.Run("root", func(t *testing.T) {
		store := &fakeRevisionStore{}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{}}, store, 0).Publish(context.Background(), "user", "root", "missing-root")
		if !errors.Is(err, ErrRootAgentNotFound) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("child", func(t *testing.T) {
		root := validAgent("root")
		root.Delegates = []agent.DelegateConfig{{AgentID: "missing", ToolName: "ask"}}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": root}}, &fakeRevisionStore{}, 0).Publish(context.Background(), "user", "root", "missing-child")
		if !errors.Is(err, ErrInvalidGraph) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("cycle", func(t *testing.T) {
		root, child := validAgent("root"), validAgent("child")
		root.Delegates = []agent.DelegateConfig{{AgentID: "child", ToolName: "ask_child"}}
		child.Delegates = []agent.DelegateConfig{{AgentID: "root", ToolName: "ask_root"}}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": root, "child": child}}, &fakeRevisionStore{}, 0).Publish(context.Background(), "user", "root", "cycle")
		if !errors.Is(err, ErrInvalidGraph) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestPublishRejectsInvalidAndOversizedWithoutWriting(t *testing.T) {
	t.Run("invalid tool", func(t *testing.T) {
		a := validAgent("root")
		a.Tools = []string{"web_serach"}
		store := &fakeRevisionStore{}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": a}}, store, 0).Publish(context.Background(), "user", "root", "invalid-tool")
		if !errors.Is(err, ErrInvalidBundle) || len(store.inputs) != 0 {
			t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
		}
	})
	t.Run("oversized", func(t *testing.T) {
		a := validAgent("root")
		a.SystemPrompt = strings.Repeat("x", deployment.MaxBundleBytes+1)
		store := &fakeRevisionStore{}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": a}}, store, 0).Publish(context.Background(), "user", "root", "oversized")
		if !errors.Is(err, ErrBundleTooLarge) || len(store.inputs) != 0 {
			t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
		}
	})
}

func TestPublishPropagatesReplayAndCancellation(t *testing.T) {
	store := &fakeRevisionStore{wasExisting: true}
	result, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": validAgent("root")}}, store, 0).Publish(context.Background(), "user", "root", "replay")
	if err != nil || !result.WasExisting {
		t.Fatalf("result/error = %+v/%v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": validAgent("root")}}, &fakeRevisionStore{}, 0).Publish(ctx, "user", "root", "cancelled")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error = %v", err)
	}
}

func TestRestoreAppendsHistoricalContentAsNewRevision(t *testing.T) {
	bundle := &deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion, DeploymentID: "root", RootAgentID: "root",
		PlatformXML: "<platform>publish</platform>",
		Agents:      []deployment.BundleAgent{{ID: "root", Name: "root", Provider: "openai", Model: "gpt-4o", SystemPrompt: "old prompt", ModelContextLimit: 128000, ContextWindow: 6, ContextKeepRatio: .5, MaxSteps: 10, Temperature: .7, MaxTokens: 100, MaxRuns: 10}},
	}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	bundle.ConfigHash = hash
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeRevisionStore{revision: &deployment.Revision{
		UserID: "user", DeploymentID: "root", RootAgentID: "root", Revision: 2,
		ConfigHash: hash, SchemaVersion: deployment.SchemaVersion, BundleJSON: raw,
	}}
	result, err := newTestService(t, &fakeAgentReader{}, store, 0).Restore(context.Background(), "user", "root", 2, "restore-r2")
	if err != nil {
		t.Fatal(err)
	}
	if result.WasExisting || len(store.inputs) != 1 {
		t.Fatalf("result/inputs = %+v/%d", result, len(store.inputs))
	}
	input := store.inputs[0]
	if input.SourceRevision != 2 || input.ConfigHash != hash || input.SchemaVersion != deployment.SchemaVersion || string(input.BundleJSON) != string(raw) {
		t.Fatalf("restore input = %+v", input)
	}
}

func TestRestoreRejectsMissingOrCorruptSourceWithoutWriting(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		store := &fakeRevisionStore{}
		_, err := newTestService(t, &fakeAgentReader{}, store, 0).Restore(context.Background(), "user", "root", 2, "restore-missing")
		if !errors.Is(err, deployment.ErrRevisionNotFound) || len(store.inputs) != 0 {
			t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
		}
	})
	t.Run("corrupt", func(t *testing.T) {
		store := &fakeRevisionStore{revision: &deployment.Revision{
			DeploymentID: "root", RootAgentID: "root", Revision: 2, ConfigHash: strings.Repeat("a", 64), SchemaVersion: 1, BundleJSON: []byte(`{"broken":true}`),
		}}
		_, err := newTestService(t, &fakeAgentReader{}, store, 0).Restore(context.Background(), "user", "root", 2, "restore-corrupt")
		if !errors.Is(err, ErrInvalidBundle) || len(store.inputs) != 0 {
			t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
		}
	})
}

func TestSameDeployableGraphProducesSameHash(t *testing.T) {
	rootA, childA := validAgent("root"), validAgent("child")
	rootA.Delegates = []agent.DelegateConfig{{AgentID: "child", ToolName: "ask_child"}}
	rootA.CreatedAt = time.Unix(1, 0)
	childA.CreatedAt = time.Unix(2, 0)
	rootB, childB := cloneTestAgent(rootA), cloneTestAgent(childA)
	rootB.CreatedAt = time.Unix(100, 0)
	childB.CreatedAt = time.Unix(200, 0)

	firstStore, secondStore := &fakeRevisionStore{}, &fakeRevisionStore{}
	first, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"child": childA, "root": rootA}}, firstStore, 0).Publish(context.Background(), "user", "root", "same-hash-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": rootB, "child": childB}}, secondStore, 0).Publish(context.Background(), "user", "root", "same-hash-b")
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision.ConfigHash != second.Revision.ConfigHash || string(first.Revision.BundleJSON) != string(second.Revision.BundleJSON) {
		t.Fatalf("equivalent graphs differ: %s/%s", first.Revision.ConfigHash, second.Revision.ConfigHash)
	}
}

func TestPublishResolvesAndFreezesDeploymentMCPURL(t *testing.T) {
	root := validAgent("root")
	root.MCPServers = []agent.MCPServerSelection{{ServerID: "fetch"}}
	store := &fakeRevisionStore{}
	svc, err := NewService(Config{
		Agents:    &fakeAgentReader{agents: map[string]*agent.Agent{"root": root}},
		Revisions: store, Platform: &agent.PlatformConfig{Body: "<platform>publish</platform>"},
		Catalog: tools.NewCatalogRegistry(),
		MCPServers: fakeMCPServerCatalog{entries: map[string]mcp.CatalogEntry{
			"fetch": {
				ServerID: "fetch", Name: "Fetch", Alias: "fetch", Enabled: true,
				StudioURL:     "http://localhost:8102/mcp",
				DeploymentURL: "http://fetch.mcp-system.svc.cluster.local/mcp",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.Publish(context.Background(), "user", "root", "freeze-mcp")
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := deployment.Parse(result.Revision.BundleJSON)
	if err != nil {
		t.Fatal(err)
	}
	servers := bundle.Agents[0].MCPServers
	if len(servers) != 1 || servers[0].ServerID != "fetch" || servers[0].Alias != "fetch" ||
		servers[0].URL != "http://fetch.mcp-system.svc.cluster.local/mcp" {
		t.Fatalf("frozen MCP servers = %+v", servers)
	}
}

func TestPublishRejectsMissingMCPSelectionBeforeRevisionWrite(t *testing.T) {
	root := validAgent("root")
	root.MCPServers = []agent.MCPServerSelection{{ServerID: "missing"}}
	store := &fakeRevisionStore{}
	svc, err := NewService(Config{
		Agents:    &fakeAgentReader{agents: map[string]*agent.Agent{"root": root}},
		Revisions: store, Platform: &agent.PlatformConfig{Body: "<platform>publish</platform>"},
		Catalog: tools.NewCatalogRegistry(), MCPServers: fakeMCPServerCatalog{entries: map[string]mcp.CatalogEntry{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Publish(context.Background(), "user", "root", "missing-mcp")
	if !errors.Is(err, ErrInvalidGraph) || len(store.inputs) != 0 {
		t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
	}
}
