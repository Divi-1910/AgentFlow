package publisher

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/deployment"
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
	copy.MCPServers = append([]agent.MCPServerConfig(nil), a.MCPServers...)
	return &copy
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
		Revision: 1, ConfigHash: input.ConfigHash, SchemaVersion: input.SchemaVersion,
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
		Catalog: tools.NewCatalogRegistry(), SnapshotAttempts: attempts,
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
	result, err := newTestService(t, reader, store, 0).Publish(context.Background(), "user", "root")
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
	if _, err := newTestService(t, reader, store, 3).Publish(context.Background(), "user", "root"); err != nil {
		t.Fatal(err)
	}
	if reader.calls["root"] != 4 || len(store.inputs) != 1 {
		t.Fatalf("calls/writes = %d/%d, want 4/1", reader.calls["root"], len(store.inputs))
	}
}

func TestPublishRejectsContinuouslyChangingSnapshot(t *testing.T) {
	reader := &fakeAgentReader{getFn: func(id string, call int) (*agent.Agent, error) {
		a := validAgent(id)
		a.SystemPrompt = fmt.Sprintf("prompt-%d", call)
		return a, nil
	}}
	store := &fakeRevisionStore{}
	_, err := newTestService(t, reader, store, 3).Publish(context.Background(), "user", "root")
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
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{}}, store, 0).Publish(context.Background(), "user", "root")
		if !errors.Is(err, ErrRootAgentNotFound) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("child", func(t *testing.T) {
		root := validAgent("root")
		root.Delegates = []agent.DelegateConfig{{AgentID: "missing", ToolName: "ask"}}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": root}}, &fakeRevisionStore{}, 0).Publish(context.Background(), "user", "root")
		if !errors.Is(err, ErrInvalidGraph) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("cycle", func(t *testing.T) {
		root, child := validAgent("root"), validAgent("child")
		root.Delegates = []agent.DelegateConfig{{AgentID: "child", ToolName: "ask_child"}}
		child.Delegates = []agent.DelegateConfig{{AgentID: "root", ToolName: "ask_root"}}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": root, "child": child}}, &fakeRevisionStore{}, 0).Publish(context.Background(), "user", "root")
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
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": a}}, store, 0).Publish(context.Background(), "user", "root")
		if !errors.Is(err, ErrInvalidBundle) || len(store.inputs) != 0 {
			t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
		}
	})
	t.Run("oversized", func(t *testing.T) {
		a := validAgent("root")
		a.SystemPrompt = strings.Repeat("x", deployment.MaxBundleBytes+1)
		store := &fakeRevisionStore{}
		_, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": a}}, store, 0).Publish(context.Background(), "user", "root")
		if !errors.Is(err, ErrBundleTooLarge) || len(store.inputs) != 0 {
			t.Fatalf("error/writes = %v/%d", err, len(store.inputs))
		}
	})
}

func TestPublishPropagatesReplayAndCancellation(t *testing.T) {
	store := &fakeRevisionStore{wasExisting: true}
	result, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": validAgent("root")}}, store, 0).Publish(context.Background(), "user", "root")
	if err != nil || !result.WasExisting {
		t.Fatalf("result/error = %+v/%v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": validAgent("root")}}, &fakeRevisionStore{}, 0).Publish(ctx, "user", "root")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error = %v", err)
	}
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
	first, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"child": childA, "root": rootA}}, firstStore, 0).Publish(context.Background(), "user", "root")
	if err != nil {
		t.Fatal(err)
	}
	second, err := newTestService(t, &fakeAgentReader{agents: map[string]*agent.Agent{"root": rootB, "child": childB}}, secondStore, 0).Publish(context.Background(), "user", "root")
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision.ConfigHash != second.Revision.ConfigHash || string(first.Revision.BundleJSON) != string(second.Revision.BundleJSON) {
		t.Fatalf("equivalent graphs differ: %s/%s", first.Revision.ConfigHash, second.Revision.ConfigHash)
	}
}
