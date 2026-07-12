package deployment_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"backend/deployment"
)

type fakeDeployStateStore struct {
	state *deployment.DeployState
	err   error
}

func (s *fakeDeployStateStore) Select(_ context.Context, input deployment.DeployStateInput) (*deployment.DeployState, error) {
	if s.err != nil {
		return nil, s.err
	}
	now := time.Unix(1, 0).UTC()
	s.state = &deployment.DeployState{
		UserID: input.UserID, DeploymentID: input.DeploymentID, Revision: input.Revision,
		ConfigHash: input.ConfigHash, ResourceName: input.ResourceName, CreatedAt: now, UpdatedAt: now,
	}
	copy := *s.state
	return &copy, nil
}

func (s *fakeDeployStateStore) Get(context.Context, string, string) (*deployment.DeployState, error) {
	if s.err != nil {
		return nil, s.err
	}
	if s.state == nil {
		return nil, deployment.ErrDeployStateNotFound
	}
	copy := *s.state
	return &copy, nil
}

type fakeRevisionReader struct {
	revision *deployment.Revision
	err      error
}

func (r *fakeRevisionReader) Get(context.Context, string, string, int) (*deployment.Revision, error) {
	if r.err != nil {
		return nil, r.err
	}
	copy := *r.revision
	copy.BundleJSON = append([]byte(nil), r.revision.BundleJSON...)
	return &copy, nil
}

func TestResourceNameUsesImmutablePublicationIdentity(t *testing.T) {
	hash := strings.Repeat("a", 64)
	got, err := deployment.ResourceName("507F1F77-BCF86CD799439099", 12, hash)
	if err != nil {
		t.Fatal(err)
	}
	if got != "af-507f1f77-bcf86cd799439099-r12-aaaaaaaaaaaa" || len(got) > 63 {
		t.Fatalf("ResourceName = %q", got)
	}
	changedRevision, _ := deployment.ResourceName("507F1F77-BCF86CD799439099", 13, hash)
	changedHash, _ := deployment.ResourceName("507F1F77-BCF86CD799439099", 12, strings.Repeat("b", 64))
	if changedRevision == got || changedHash == got {
		t.Fatal("resource name did not change with revision/hash")
	}
}

func TestResourceNameBoundsAndValidation(t *testing.T) {
	got, err := deployment.ResourceName(strings.Repeat("LONG_name.", 20), 1, strings.Repeat("c", 64))
	if err != nil || len(got) > 63 || strings.HasSuffix(got, "-") {
		t.Fatalf("ResourceName = %q err=%v", got, err)
	}
	for _, tc := range []struct {
		id       string
		revision int
		hash     string
	}{{"", 1, strings.Repeat("a", 64)}, {"id", 0, strings.Repeat("a", 64)}, {"id", 1, "bad"}} {
		if _, err := deployment.ResourceName(tc.id, tc.revision, tc.hash); err == nil {
			t.Fatalf("ResourceName(%q, %d, %q) succeeded", tc.id, tc.revision, tc.hash)
		}
	}
}

func TestServiceSelectsAndBuildsVerifiedRuntimeInputs(t *testing.T) {
	bundle := deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion, DeploymentID: "root", RootAgentID: "root", PlatformXML: "<platform>test</platform>",
		Agents: []deployment.BundleAgent{{
			ID: "root", Name: "Root", Provider: "openai", Model: "gpt-4o", SystemPrompt: "prompt",
			Tools: []string{}, Delegates: []deployment.BundleDelegate{}, MCPServers: []deployment.BundleMCPServer{},
			ModelContextLimit: 128000, ContextWindow: 6, ContextKeepRatio: .5,
			MaxSteps: 25, Temperature: .7, MaxTokens: 100, MaxRuns: 10,
		}},
	}
	bundle.ConfigHash, _ = bundle.CanonicalHash()
	raw, _ := json.Marshal(bundle)
	revision := &deployment.Revision{
		UserID: "user", DeploymentID: "root", RootAgentID: "root", Revision: 3,
		ConfigHash: bundle.ConfigHash, SchemaVersion: deployment.SchemaVersion, BundleJSON: raw,
	}
	states := &fakeDeployStateStore{}
	service, err := deployment.NewService(states, &fakeRevisionReader{revision: revision})
	if err != nil {
		t.Fatal(err)
	}
	selected, err := service.SelectRevision(context.Background(), "user", "root", 3)
	if err != nil || selected.State.ConfigHash != bundle.ConfigHash || selected.Revision.Revision != 3 {
		t.Fatalf("SelectRevision = %+v err=%v", selected, err)
	}
	inputs, err := service.BuildRuntimeInputs(context.Background(), "user", "root")
	if err != nil {
		t.Fatal(err)
	}
	wantName, _ := deployment.ResourceName("root", 3, bundle.ConfigHash)
	if inputs.ResourceName != wantName || inputs.RootAgentID != "root" || inputs.Revision != 3 || string(inputs.BundleJSON) != string(raw) {
		t.Fatalf("runtime inputs = %+v", inputs)
	}
	inputs.BundleJSON[0] = 'x'
	if revision.BundleJSON[0] == 'x' {
		t.Fatal("runtime inputs shared revision bytes")
	}
	revision.BundleJSON = []byte(`{"schema_version":1}`)
	if _, err := service.BuildRuntimeInputs(context.Background(), "user", "root"); err == nil || !strings.Contains(err.Error(), "selected bundle is invalid") {
		t.Fatalf("invalid selected bundle error = %v", err)
	}
}

func TestServiceRejectsMissingAndInconsistentSelection(t *testing.T) {
	missing := errors.New("missing revision")
	stateStore := &fakeDeployStateStore{}
	service, err := deployment.NewService(stateStore, &fakeRevisionReader{err: missing})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SelectRevision(context.Background(), "user", "root", 1); !errors.Is(err, missing) {
		t.Fatalf("missing revision error = %v", err)
	}
	if stateStore.state != nil {
		t.Fatal("missing revision changed deploy state")
	}

	hash := strings.Repeat("a", 64)
	name, _ := deployment.ResourceName("root", 1, hash)
	states := &fakeDeployStateStore{state: &deployment.DeployState{
		UserID: "user", DeploymentID: "root", Revision: 1,
		ConfigHash: strings.Repeat("b", 64), ResourceName: name,
	}}
	service, _ = deployment.NewService(states, &fakeRevisionReader{revision: &deployment.Revision{
		UserID: "user", DeploymentID: "root", RootAgentID: "root", Revision: 1, ConfigHash: hash,
	}})
	if _, err := service.GetSelectedRevision(context.Background(), "user", "root"); !errors.Is(err, deployment.ErrDeployStateConflict) {
		t.Fatalf("inconsistent selection error = %v", err)
	}
	if _, err := deployment.NewService(nil, &fakeRevisionReader{}); err == nil {
		t.Fatal("NewService accepted nil state store")
	}
}
