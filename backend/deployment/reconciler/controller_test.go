package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"backend/deployment"
)

const testRuntimeImage = "registry.example/agentflow-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type fakeStore struct {
	mu sync.Mutex

	claimState      *deployment.DeployState
	claimServed     bool
	refresh         bool
	refreshErr      error
	storagePlans    []deployment.StoragePlanObservation
	storageReady    *deployment.StorageReadyObservation
	storageMissing  *deployment.StorageMissingObservation
	storagePlanErr  error
	storageReadyErr error
	progress        []deployment.ProgressObservation
	ready           *deployment.ReadyObservation
	failure         *deployment.FailureObservation
	deleted         *deployment.ClaimRef
	completionOkay  bool
}

func (s *fakeStore) ClaimDue(_ context.Context, request deployment.ClaimRequest) (*deployment.DeployState, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimState == nil || s.claimServed {
		return nil, false, nil
	}
	s.claimServed = true
	copy := *s.claimState
	copy.Reconcile.Attempt++
	copy.Reconcile.Claim = &deployment.ReconcileClaim{
		Generation: copy.Desired.Generation, Owner: request.Owner, Token: request.Token,
		LeaseExpiresAt: request.Now.Add(request.LeaseDuration),
	}
	return &copy, true, nil
}

func (s *fakeStore) RefreshClaim(context.Context, deployment.ClaimRef, time.Time, time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refresh, s.refreshErr
}

func (s *fakeStore) RecordStoragePlan(_ context.Context, observation deployment.StoragePlanObservation) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.storagePlans = append(s.storagePlans, observation)
	return s.completionOkay, s.storagePlanErr
}

func (s *fakeStore) RecordStorageReady(_ context.Context, observation deployment.StorageReadyObservation) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := observation
	s.storageReady = &copy
	return s.completionOkay, s.storageReadyErr
}

func (s *fakeStore) RecordStorageMissing(_ context.Context, observation deployment.StorageMissingObservation) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := observation
	s.storageMissing = &copy
	return s.completionOkay, nil
}

func (s *fakeStore) RecordProgress(_ context.Context, observation deployment.ProgressObservation) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.progress = append(s.progress, observation)
	return s.completionOkay, nil
}

func (s *fakeStore) RecordReady(_ context.Context, observation deployment.ReadyObservation) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := observation
	s.ready = &copy
	return s.completionOkay, nil
}

func (s *fakeStore) RecordFailure(_ context.Context, observation deployment.FailureObservation) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := observation
	s.failure = &copy
	return s.completionOkay, nil
}

func (s *fakeStore) RecordDeleted(_ context.Context, claim deployment.ClaimRef, _ time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := claim
	s.deleted = &copy
	return s.completionOkay, nil
}

type fakeRevisions struct {
	revision *deployment.Revision
	err      error
}

func (r *fakeRevisions) Get(context.Context, string, string, int) (*deployment.Revision, error) {
	if r.err != nil {
		return nil, r.err
	}
	if r.revision == nil {
		return nil, deployment.ErrRevisionNotFound
	}
	copy := *r.revision
	copy.BundleJSON = append([]byte(nil), r.revision.BundleJSON...)
	return &copy, nil
}

type fakeRuntime struct {
	run    func(context.Context, RunAttempt, ProgressReporter, StorageReporter) (RunResult, error)
	delete func(context.Context, DeleteAttempt) error
}

func (r *fakeRuntime) ReconcileRun(
	ctx context.Context,
	attempt RunAttempt,
	report ProgressReporter,
	reportStorage StorageReporter,
) (RunResult, error) {
	if r.run == nil {
		return RunResult{}, errors.New("unexpected run reconciliation")
	}
	return r.run(ctx, attempt, report, reportStorage)
}

func (r *fakeRuntime) ReconcileDelete(ctx context.Context, attempt DeleteAttempt) error {
	if r.delete == nil {
		return errors.New("unexpected delete reconciliation")
	}
	return r.delete(ctx, attempt)
}

func TestControllerRecordsVerifiedReadyResult(t *testing.T) {
	now := time.Date(2026, 10, 13, 1, 2, 3, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	store := &fakeStore{refresh: true, completionOkay: true}
	runtime := &fakeRuntime{run: func(
		_ context.Context,
		attempt RunAttempt,
		report ProgressReporter,
		reportStorage StorageReporter,
	) (RunResult, error) {
		if attempt.Revision.ConfigHash != state.Desired.Target.ConfigHash {
			t.Fatalf("runtime revision hash = %q", attempt.Revision.ConfigHash)
		}
		binding := deployment.StorageBindingObservation{
			StorageID:        attempt.State.Storage.StorageID,
			Namespace:        attempt.State.Storage.Namespace,
			PVCName:          attempt.State.Storage.PVCName,
			PVCUID:           "11111111-2222-3333-4444-555555555555",
			StorageClassName: "standard",
			CapacityBytes:    attempt.State.Storage.RequestedCapacityBytes,
			AccessMode:       attempt.State.Storage.AccessMode,
			VolumeMode:       attempt.State.Storage.VolumeMode,
		}
		if err := reportStorage.Ready(binding); err != nil {
			return RunResult{}, err
		}
		if err := report(deployment.DeploymentPhaseStarting, false); err != nil {
			return RunResult{}, err
		}
		return RunResult{
			Endpoint: "http://af-test.agentflow-runtime.svc.cluster.local",
			Resources: deployment.ResourceRefs{
				Namespace: "agentflow-runtime", DeploymentName: "af-test", ServiceName: "af-test",
				DeliverySecretName: "af-test-delivery", RuntimeSecretName: "af-test-runtime",
			},
		}, nil
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now,
		Config{LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.progress) != 2 || store.progress[0].Phase != deployment.DeploymentPhaseProvisioning ||
		store.progress[1].Phase != deployment.DeploymentPhaseStarting {
		t.Fatalf("progress = %+v", store.progress)
	}
	if len(store.storagePlans) != 1 || store.storageReady == nil ||
		store.storageReady.Binding.PVCName != store.storagePlans[0].Plan.PVCName {
		t.Fatalf("storage plan=%+v ready=%+v", store.storagePlans, store.storageReady)
	}
	if store.ready == nil || store.ready.Target != state.Desired.Target || store.ready.Resources.DeploymentName != "af-test" {
		t.Fatalf("ready observation = %+v", store.ready)
	}
	if store.failure != nil {
		t.Fatalf("unexpected failure = %+v", store.failure)
	}
}

func TestControllerRejectsReadyResultWithoutStorageVerification(t *testing.T) {
	now := time.Date(2026, 10, 13, 1, 30, 0, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	store := &fakeStore{refresh: true, completionOkay: true}
	runtime := &fakeRuntime{run: func(
		context.Context,
		RunAttempt,
		ProgressReporter,
		StorageReporter,
	) (RunResult, error) {
		return RunResult{Endpoint: "http://unverified.example"}, nil
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now,
		Config{LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.ready != nil {
		t.Fatalf("unverified runtime recorded ready: %+v", store.ready)
	}
	if store.failure == nil || store.failure.Code != "storage_not_verified" || store.failure.Retryable {
		t.Fatalf("unverified storage failure = %+v", store.failure)
	}
}

func TestControllerRecordsStorageIdentityConflictAsTerminal(t *testing.T) {
	now := time.Date(2026, 10, 13, 1, 45, 0, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	store := &fakeStore{
		refresh: true, completionOkay: true, storageReadyErr: deployment.ErrDeployStorageConflict,
	}
	runtime := &fakeRuntime{run: func(
		_ context.Context,
		attempt RunAttempt,
		_ ProgressReporter,
		reportStorage StorageReporter,
	) (RunResult, error) {
		binding := deployment.StorageBindingObservation{
			StorageID:        attempt.State.Storage.StorageID,
			Namespace:        attempt.State.Storage.Namespace,
			PVCName:          attempt.State.Storage.PVCName,
			PVCUID:           "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			StorageClassName: "standard",
			CapacityBytes:    attempt.State.Storage.RequestedCapacityBytes,
			AccessMode:       attempt.State.Storage.AccessMode,
			VolumeMode:       attempt.State.Storage.VolumeMode,
		}
		return RunResult{}, reportStorage.Ready(binding)
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now,
		Config{LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failure == nil || store.failure.Code != "storage_identity_conflict" || store.failure.Retryable {
		t.Fatalf("storage identity failure = %+v", store.failure)
	}
}

func TestControllerPersistsMissingRetainedStorageBeforeFailure(t *testing.T) {
	now := time.Date(2026, 10, 13, 1, 50, 0, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	plan, err := deployment.NewStoragePlan(state.UserID, state.DeploymentID, state.Desired.Target.Namespace)
	if err != nil {
		t.Fatal(err)
	}
	state.Storage = deployment.StorageState{
		StoragePlan: plan, Phase: deployment.StoragePhaseReady,
		PVCUID: "retained-pvc-uid", StorageClassName: "standard",
		CapacityBytes: deployment.DefaultStorageCapacityBytes,
	}
	store := &fakeStore{refresh: true, completionOkay: true}
	runtime := &fakeRuntime{run: func(
		_ context.Context,
		_ RunAttempt,
		_ ProgressReporter,
		reportStorage StorageReporter,
	) (RunResult, error) {
		if err := reportStorage.Missing(); err != nil {
			return RunResult{}, err
		}
		return RunResult{}, TerminalError("storage_missing", "deployment retained storage is missing", nil)
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now,
		Config{LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.storageMissing == nil || store.storageMissing.Claim.Generation != state.Desired.Generation {
		t.Fatalf("storage missing observation = %+v", store.storageMissing)
	}
	if store.failure == nil || store.failure.Code != "storage_missing" || store.failure.Retryable {
		t.Fatalf("storage missing failure = %+v", store.failure)
	}
}

func TestControllerRecordsVerifiedDeletion(t *testing.T) {
	now := time.Date(2026, 10, 13, 2, 3, 4, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	state.Desired.Action = deployment.DesiredActionDelete
	store := &fakeStore{refresh: true, completionOkay: true}
	runtime := &fakeRuntime{delete: func(_ context.Context, attempt DeleteAttempt) error {
		if attempt.State.Desired.Generation != state.Desired.Generation {
			t.Fatalf("delete generation = %d", attempt.State.Desired.Generation)
		}
		return nil
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now,
		Config{LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.progress) != 1 || store.progress[0].Phase != deployment.DeploymentPhaseDeleting {
		t.Fatalf("progress = %+v", store.progress)
	}
	if store.deleted == nil || store.deleted.Generation != state.Desired.Generation {
		t.Fatalf("deleted claim = %+v", store.deleted)
	}
}

func TestControllerCancelsAttemptWhenLeaseRefreshLosesClaim(t *testing.T) {
	now := time.Date(2026, 10, 13, 3, 4, 5, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	store := &fakeStore{completionOkay: true}
	runtimeStarted := make(chan struct{})
	runtime := &fakeRuntime{run: func(ctx context.Context, _ RunAttempt, _ ProgressReporter, _ StorageReporter) (RunResult, error) {
		close(runtimeStarted)
		<-ctx.Done()
		return RunResult{}, ctx.Err()
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now,
		Config{LeaseDuration: 20 * time.Millisecond, HeartbeatInterval: 5 * time.Millisecond})

	done := make(chan struct{})
	go func() {
		controller.reconcileClaim(context.Background(), state)
		close(done)
	}()
	select {
	case <-runtimeStarted:
	case <-time.After(time.Second):
		t.Fatal("runtime did not start")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("claim loss did not cancel runtime")
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.ready != nil || store.failure != nil || store.deleted != nil {
		t.Fatalf("claim loss recorded terminal state: ready=%+v failure=%+v deleted=%+v", store.ready, store.failure, store.deleted)
	}
}

func TestControllerSchedulesTypedRetryWithDurableBackoff(t *testing.T) {
	now := time.Date(2026, 10, 13, 4, 5, 6, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	state.Reconcile.Attempt = 3
	store := &fakeStore{refresh: true, completionOkay: true}
	runtime := &fakeRuntime{run: func(context.Context, RunAttempt, ProgressReporter, StorageReporter) (RunResult, error) {
		return RunResult{}, RetryableError("kubernetes_unavailable", "Kubernetes API is temporarily unavailable", errors.New("dial failed"))
	}}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, runtime, now, Config{
		LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute,
		RetryPolicy: RetryPolicy{BaseDelay: time.Minute, MaximumDelay: 10 * time.Minute},
	})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failure == nil || !store.failure.Retryable || store.failure.Code != "kubernetes_unavailable" {
		t.Fatalf("failure = %+v", store.failure)
	}
	delay := store.failure.RetryAt.Sub(now)
	if delay < 2*time.Minute || delay > 4*time.Minute {
		t.Fatalf("retry delay = %v, want jittered delay in [2m, 4m]", delay)
	}
}

func TestControllerRejectsRevisionMismatchBeforeRuntime(t *testing.T) {
	now := time.Date(2026, 10, 13, 5, 6, 7, 0, time.UTC)
	state, revision := claimedRunState(t, now)
	revision.ConfigHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	store := &fakeStore{refresh: true, completionOkay: true}
	controller := newTestController(t, store, &fakeRevisions{revision: revision}, &fakeRuntime{}, now,
		Config{LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})

	controller.reconcileClaim(context.Background(), state)

	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failure == nil || store.failure.Retryable || store.failure.Code != "revision_target_mismatch" {
		t.Fatalf("failure = %+v", store.failure)
	}
	if len(store.progress) != 0 {
		t.Fatalf("progress was recorded before revision verification: %+v", store.progress)
	}
}

func TestControllerRunStopsCleanlyOnCancellation(t *testing.T) {
	now := time.Date(2026, 10, 13, 6, 7, 8, 0, time.UTC)
	store := &fakeStore{}
	controller := newTestController(t, store, &fakeRevisions{}, &fakeRuntime{}, now,
		Config{Workers: 2, PollInterval: time.Hour, LeaseDuration: time.Hour, HeartbeatInterval: 30 * time.Minute})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- controller.Run(ctx) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("controller did not stop after cancellation")
	}
}

func TestRetryPolicyIsBounded(t *testing.T) {
	policy := RetryPolicy{BaseDelay: time.Second, MaximumDelay: 10 * time.Second}
	for _, attempt := range []int{0, 1, 2, 20} {
		delay := policy.Delay(attempt, "claim-token")
		if delay <= 0 || delay > 10*time.Second {
			t.Fatalf("attempt %d delay = %v", attempt, delay)
		}
	}
}

func newTestController(t *testing.T, store Store, revisions RevisionReader, runtime Runtime, now time.Time, override Config) *Controller {
	t.Helper()
	config := override
	config.Store = store
	config.Revisions = revisions
	config.Runtime = runtime
	config.Owner = "controller-test"
	config.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	config.Now = func() time.Time { return now }
	config.NewToken = func() (string, error) { return "claim-token", nil }
	controller, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	return controller
}

func claimedRunState(t *testing.T, now time.Time) (*deployment.DeployState, *deployment.Revision) {
	t.Helper()
	bundle := deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion,
		DeploymentID:  "deployment-1",
		RootAgentID:   "agent-1",
		PlatformXML:   "<platform />",
		Agents: []deployment.BundleAgent{{
			ID: "agent-1", Name: "Agent", Description: "test", Provider: "openai", Model: "test-model",
			SystemPrompt: "Test", Tools: []string{}, Delegates: []deployment.BundleDelegate{}, MCPServers: []deployment.BundleMCPServer{},
			ModelContextLimit: 4096, ContextWindow: 2048, ContextKeepRatio: 0.8,
			SummarizationModel: "test-model", MaxSteps: 10, Temperature: 0.2, MaxTokens: 512, MaxRuns: 4,
		}},
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
	target := deployment.DeploymentTarget{
		Revision: 1, ConfigHash: hash, SchemaVersion: deployment.SchemaVersion,
		Namespace: "agentflow-runtime", RuntimeImage: testRuntimeImage,
	}
	state := &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion,
		UserID:        "507f1f77bcf86cd799439011", DeploymentID: bundle.DeploymentID,
		Desired:  deployment.DesiredState{Generation: 7, Action: deployment.DesiredActionRun, Target: target, RequestedAt: now},
		Observed: deployment.ObservedState{Phase: deployment.DeploymentPhasePending},
		Reconcile: deployment.ReconcileState{Attempt: 1, Claim: &deployment.ReconcileClaim{
			Generation: 7, Owner: "controller-test", Token: "claim-token", LeaseExpiresAt: now.Add(time.Hour),
		}},
	}
	revision := &deployment.Revision{
		UserID: state.UserID, DeploymentID: state.DeploymentID, RootAgentID: bundle.RootAgentID,
		Revision: 1, ConfigHash: hash, SchemaVersion: deployment.SchemaVersion, BundleJSON: raw, CreatedAt: now,
	}
	return state, revision
}
