package deployment_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"backend/deployment"
)

const testRuntimeImage = "registry.example/agentflow-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type fakeDeployStateStore struct {
	state       *deployment.DeployState
	runInput    deployment.RunStateInput
	deleteInput deployment.DeleteStateInput
	changed     bool
	err         error
}

func (s *fakeDeployStateStore) RequestRun(_ context.Context, input deployment.RunStateInput) (*deployment.DeployState, bool, error) {
	s.runInput = input
	return s.result()
}

func (s *fakeDeployStateStore) RequestDelete(_ context.Context, input deployment.DeleteStateInput) (*deployment.DeployState, bool, error) {
	s.deleteInput = input
	return s.result()
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

func (s *fakeDeployStateStore) result() (*deployment.DeployState, bool, error) {
	if s.err != nil {
		return nil, false, s.err
	}
	if s.state == nil {
		return nil, false, deployment.ErrDeployStateConflict
	}
	copy := *s.state
	return &copy, s.changed, nil
}

type fakeRevisionReader struct {
	revisions []deployment.Revision
	err       error
}

func (r *fakeRevisionReader) Get(_ context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error) {
	if r.err != nil {
		return nil, r.err
	}
	for i := range r.revisions {
		candidate := r.revisions[i]
		if candidate.UserID == userID && candidate.DeploymentID == deploymentID && candidate.Revision == revision {
			return &candidate, nil
		}
	}
	return nil, deployment.ErrRevisionNotFound
}

func (r *fakeRevisionReader) List(_ context.Context, userID, deploymentID string, limit int) ([]deployment.Revision, error) {
	if r.err != nil {
		return nil, r.err
	}
	result := make([]deployment.Revision, 0, limit)
	for i := len(r.revisions) - 1; i >= 0 && len(result) < limit; i-- {
		candidate := r.revisions[i]
		if candidate.UserID == userID && candidate.DeploymentID == deploymentID {
			result = append(result, candidate)
		}
	}
	return result, nil
}

func TestValidateDeploymentTarget(t *testing.T) {
	valid := deployment.DeploymentTarget{
		Revision: 3, ConfigHash: strings.Repeat("a", 64), SchemaVersion: 1,
		Namespace: "agentflow-runtime", RuntimeImage: testRuntimeImage,
	}
	if err := deployment.ValidateDeploymentTarget(valid); err != nil {
		t.Fatalf("valid target: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*deployment.DeploymentTarget)
	}{
		{name: "zero revision", mutate: func(target *deployment.DeploymentTarget) { target.Revision = 0 }},
		{name: "invalid hash", mutate: func(target *deployment.DeploymentTarget) { target.ConfigHash = "bad" }},
		{name: "zero schema", mutate: func(target *deployment.DeploymentTarget) { target.SchemaVersion = 0 }},
		{name: "invalid namespace", mutate: func(target *deployment.DeploymentTarget) { target.Namespace = "Not_DNS" }},
		{name: "mutable image tag", mutate: func(target *deployment.DeploymentTarget) { target.RuntimeImage = "runtime:latest" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := valid
			test.mutate(&target)
			if err := deployment.ValidateDeploymentTarget(target); !errors.Is(err, deployment.ErrDeployStateTarget) {
				t.Fatalf("ValidateDeploymentTarget error = %v", err)
			}
		})
	}
}

func TestNewReconcileClaimToken(t *testing.T) {
	first, err := deployment.NewReconcileClaimToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := deployment.NewReconcileClaimToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 || first == second {
		t.Fatalf("claim tokens = %q and %q", first, second)
	}
	if err := deployment.ValidateClaimIdentity("controller-1", first); err != nil {
		t.Fatalf("generated token rejected: %v", err)
	}
}

func TestStoragePlanIsStableAndOwnerScoped(t *testing.T) {
	first, err := deployment.NewStoragePlan("owner-a", "deployment", "agentflow-runtime")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := deployment.NewStoragePlan("owner-a", "deployment", "agentflow-runtime")
	if err != nil {
		t.Fatal(err)
	}
	otherOwner, err := deployment.NewStoragePlan("owner-b", "deployment", "agentflow-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if first != replay {
		t.Fatalf("stable storage plan changed: %+v != %+v", first, replay)
	}
	if first.StorageID == otherOwner.StorageID || first.PVCName == otherOwner.PVCName {
		t.Fatalf("owner-scoped storage collided: %+v and %+v", first, otherOwner)
	}
	if err := deployment.ValidateStoragePlan(first); err != nil {
		t.Fatalf("generated plan rejected: %v", err)
	}
	binding := deployment.StorageBindingObservation{
		StorageID: first.StorageID, Namespace: first.Namespace, PVCName: first.PVCName,
		PVCUID: "11111111-2222-3333-4444-555555555555", StorageClassName: "standard",
		CapacityBytes: first.RequestedCapacityBytes, AccessMode: first.AccessMode, VolumeMode: first.VolumeMode,
	}
	if err := deployment.ValidateStorageBinding(binding); err != nil {
		t.Fatalf("valid storage binding rejected: %v", err)
	}
	binding.CapacityBytes--
	if err := deployment.ValidateStorageBinding(binding); !errors.Is(err, deployment.ErrDeployStorageConflict) {
		t.Fatalf("undersized storage binding error = %v", err)
	}
}

func TestServiceRequestRunUsesLatestOwnedRevision(t *testing.T) {
	revision := deployment.Revision{
		UserID: "user", DeploymentID: "root", RootAgentID: "root", Revision: 3,
		ConfigHash: strings.Repeat("a", 64), SchemaVersion: 1,
	}
	states := &fakeDeployStateStore{
		changed: true,
		state: &deployment.DeployState{
			RecordVersion: deployment.DeployStateRecordVersion, UserID: "user", DeploymentID: "root",
			Desired: deployment.DesiredState{Generation: 1, Action: deployment.DesiredActionRun},
		},
	}
	service, err := deployment.NewService(states, &fakeRevisionReader{revisions: []deployment.Revision{revision}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.RequestRun(context.Background(), deployment.RunRequest{
		UserID: "user", DeploymentID: "root", Revision: 3, ExpectedGeneration: 0,
		Namespace: "agentflow-runtime", RuntimeImage: testRuntimeImage,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || states.runInput.Target.Revision != 3 ||
		states.runInput.Target.ConfigHash != revision.ConfigHash ||
		states.runInput.Target.RuntimeImage != testRuntimeImage || states.runInput.RequestedAt.IsZero() {
		t.Fatalf("run result = %+v input = %+v", result, states.runInput)
	}
}

func TestServiceRequestRunRejectsHistoricalRevision(t *testing.T) {
	revisions := []deployment.Revision{
		{UserID: "user", DeploymentID: "root", Revision: 1, ConfigHash: strings.Repeat("a", 64), SchemaVersion: 1},
		{UserID: "user", DeploymentID: "root", Revision: 2, ConfigHash: strings.Repeat("b", 64), SchemaVersion: 1},
	}
	service, err := deployment.NewService(&fakeDeployStateStore{}, &fakeRevisionReader{revisions: revisions})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RequestRun(context.Background(), deployment.RunRequest{
		UserID: "user", DeploymentID: "root", Revision: 1,
		Namespace: "agentflow-runtime", RuntimeImage: testRuntimeImage,
	})
	if !errors.Is(err, deployment.ErrDeployStateRollback) {
		t.Fatalf("historical revision error = %v", err)
	}
}

func TestServiceRequestRunReplaysAppliedTargetAfterLaterPublication(t *testing.T) {
	target := deployment.DeploymentTarget{
		Revision: 1, ConfigHash: strings.Repeat("a", 64), SchemaVersion: 1,
		Namespace: "agentflow-runtime", RuntimeImage: testRuntimeImage,
	}
	states := &fakeDeployStateStore{state: &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion, UserID: "user", DeploymentID: "root",
		Desired: deployment.DesiredState{Generation: 4, Action: deployment.DesiredActionRun, Target: target},
	}}
	revisions := []deployment.Revision{
		{UserID: "user", DeploymentID: "root", Revision: 1, ConfigHash: target.ConfigHash, SchemaVersion: 1},
		{UserID: "user", DeploymentID: "root", Revision: 2, ConfigHash: strings.Repeat("b", 64), SchemaVersion: 1},
	}
	service, err := deployment.NewService(states, &fakeRevisionReader{revisions: revisions})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.RequestRun(context.Background(), deployment.RunRequest{
		UserID: "user", DeploymentID: "root", Revision: 1, ExpectedGeneration: 3,
		Namespace: target.Namespace, RuntimeImage: target.RuntimeImage,
	})
	if err != nil || result.Changed || result.State.Desired.Generation != 4 {
		t.Fatalf("RequestRun replay = %+v err=%v", result, err)
	}
	if states.runInput.DeploymentID != "" {
		t.Fatalf("exact replay reached mutation store: %+v", states.runInput)
	}
}

func TestServiceRequestRunRedeploysSameRevisionFromCurrentGeneration(t *testing.T) {
	target := deployment.DeploymentTarget{
		Revision: 2, ConfigHash: strings.Repeat("b", 64), SchemaVersion: 1,
		Namespace: "agentflow-runtime", RuntimeImage: testRuntimeImage,
	}
	states := &fakeDeployStateStore{
		changed: true,
		state: &deployment.DeployState{
			RecordVersion: deployment.DeployStateRecordVersion, UserID: "user", DeploymentID: "root",
			Desired: deployment.DesiredState{Generation: 4, Action: deployment.DesiredActionRun, Target: target},
		},
	}
	revisions := []deployment.Revision{{
		UserID: "user", DeploymentID: "root", Revision: target.Revision,
		ConfigHash: target.ConfigHash, SchemaVersion: target.SchemaVersion,
	}}
	service, err := deployment.NewService(states, &fakeRevisionReader{revisions: revisions})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.RequestRun(context.Background(), deployment.RunRequest{
		UserID: "user", DeploymentID: "root", Revision: target.Revision, ExpectedGeneration: 4,
		Namespace: target.Namespace, RuntimeImage: target.RuntimeImage,
	})
	if err != nil || !result.Changed {
		t.Fatalf("RequestRun redeploy = %+v err=%v", result, err)
	}
	if states.runInput.ExpectedGeneration != 4 || states.runInput.Target != target {
		t.Fatalf("redeploy mutation input = %+v", states.runInput)
	}
}

func TestServiceRequestRunRejectsNamespaceDriftAfterStoragePlanning(t *testing.T) {
	target := deployment.DeploymentTarget{
		Revision: 2, ConfigHash: strings.Repeat("b", 64), SchemaVersion: 1,
		Namespace: "other-runtime", RuntimeImage: testRuntimeImage,
	}
	states := &fakeDeployStateStore{state: &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion, UserID: "user", DeploymentID: "root",
		Desired: deployment.DesiredState{Generation: 1, Action: deployment.DesiredActionRun},
		Storage: deployment.StorageState{
			Phase:       deployment.StoragePhaseRetained,
			StoragePlan: deployment.StoragePlan{Namespace: "agentflow-runtime"},
		},
	}}
	revisions := []deployment.Revision{{
		UserID: "user", DeploymentID: "root", Revision: 2,
		ConfigHash: target.ConfigHash, SchemaVersion: target.SchemaVersion,
	}}
	service, err := deployment.NewService(states, &fakeRevisionReader{revisions: revisions})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RequestRun(context.Background(), deployment.RunRequest{
		UserID: "user", DeploymentID: "root", Revision: 2, ExpectedGeneration: 1,
		Namespace: target.Namespace, RuntimeImage: target.RuntimeImage,
	})
	if !errors.Is(err, deployment.ErrDeployStorageConflict) {
		t.Fatalf("namespace drift error = %v", err)
	}
	if states.runInput.DeploymentID != "" {
		t.Fatalf("namespace drift reached mutation store: %+v", states.runInput)
	}
}

func TestServiceRequestDeleteAndGet(t *testing.T) {
	state := &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion, UserID: "user", DeploymentID: "root",
		Desired: deployment.DesiredState{Generation: 4, Action: deployment.DesiredActionDelete},
	}
	states := &fakeDeployStateStore{state: state, changed: true}
	service, err := deployment.NewService(states, &fakeRevisionReader{})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.RequestDelete(context.Background(), deployment.DeleteRequest{
		UserID: "user", DeploymentID: "root", ExpectedGeneration: 3,
	})
	if err != nil || !result.Changed || states.deleteInput.ExpectedGeneration != 3 || states.deleteInput.RequestedAt.IsZero() {
		t.Fatalf("RequestDelete = %+v input=%+v err=%v", result, states.deleteInput, err)
	}
	loaded, err := service.Get(context.Background(), "user", "root")
	if err != nil || loaded.Desired.Generation != 4 {
		t.Fatalf("Get = %+v err=%v", loaded, err)
	}
	if _, err := deployment.NewService(nil, &fakeRevisionReader{}); err == nil {
		t.Fatal("NewService accepted nil state store")
	}
}

func TestDeploymentValidatorsRejectAmbiguousValues(t *testing.T) {
	if err := deployment.ValidateClaimIdentity("controller one", "token"); !errors.Is(err, deployment.ErrDeployStateClaim) {
		t.Fatalf("claim identity error = %v", err)
	}
	if err := deployment.ValidateProgressPhase(deployment.DeploymentPhaseReady); err == nil {
		t.Fatal("ready accepted as an intermediate progress phase")
	}
	if err := deployment.ValidateDeploymentError("Bad Code", "message"); err == nil {
		t.Fatal("invalid error code accepted")
	}
	if err := deployment.ValidateDeploymentError("apply_failed", "unsafe\nmessage"); err == nil {
		t.Fatal("control byte in error message accepted")
	}
	if err := deployment.ValidateDeploymentError("apply_failed", strings.Repeat("x", deployment.MaxDeploymentErrorMessage+1)); err == nil {
		t.Fatal("oversized error message accepted")
	}
	if err := deployment.ValidateDeploymentError("apply_failed", "kubernetes api unavailable"); err != nil {
		t.Fatalf("valid deployment error rejected: %v", err)
	}
}
