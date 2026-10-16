package mongorepo_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"backend/deployment"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const stateRuntimeImage = "registry.example/agentflow-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

func deploymentStateRepo(t *testing.T) *mongorepo.DeploymentStateRepo {
	t.Helper()
	r := mongorepo.NewDeploymentStateRepo(col(t, "deployment_states"))
	if err := r.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	return r
}

func deploymentTarget(revision int, value string) deployment.DeploymentTarget {
	return deployment.DeploymentTarget{
		Revision: revision, ConfigHash: revisionHash(value), SchemaVersion: deployment.SchemaVersion,
		Namespace: "agentflow-runtime", RuntimeImage: stateRuntimeImage,
	}
}

func runStateInput(revision int, value string, expected int64, now time.Time) deployment.RunStateInput {
	return deployment.RunStateInput{
		UserID: userA, DeploymentID: "507f1f77bcf86cd799439099", ExpectedGeneration: expected,
		Target: deploymentTarget(revision, value), RequestedAt: now,
	}
}

func claimRef(state *deployment.DeployState) deployment.ClaimRef {
	return deployment.ClaimRef{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Reconcile.Claim.Generation,
		Owner: state.Reconcile.Claim.Owner, Token: state.Reconcile.Claim.Token,
	}
}

func TestDeploymentStateIndexesCoexistWithV2DueIndex(t *testing.T) {
	ctx := context.Background()
	states := col(t, "deployment_states")
	legacy := mongo.IndexModel{
		Keys: bson.D{
			{Key: "record_version", Value: 1},
			{Key: "reconcile.due_at", Value: 1},
			{Key: "reconcile.claim.lease_expires_at", Value: 1},
			{Key: "created_at", Value: 1},
		},
		Options: options.Index().
			SetName("deployment_states_due_claim").
			SetPartialFilterExpression(bson.D{
				{Key: "record_version", Value: deployment.PreviousDeployStateRecordVersion},
				{Key: "reconcile.due_at", Value: bson.D{{Key: "$type", Value: "date"}}},
			}),
	}
	if _, err := states.Indexes().CreateOne(ctx, legacy); err != nil {
		t.Fatal(err)
	}
	if err := mongorepo.NewDeploymentStateRepo(states).EnsureIndexes(ctx); err != nil {
		t.Fatalf("EnsureIndexes with v2 due index: %v", err)
	}
}

func storageBinding(plan deployment.StoragePlan) deployment.StorageBindingObservation {
	return deployment.StorageBindingObservation{
		StorageID: plan.StorageID, Namespace: plan.Namespace, PVCName: plan.PVCName,
		PVCUID: "11111111-2222-3333-4444-555555555555", StorageClassName: "standard",
		CapacityBytes: plan.RequestedCapacityBytes, AccessMode: plan.AccessMode, VolumeMode: plan.VolumeMode,
	}
}

func TestDeploymentStateMutationsUseGenerationCASAndForwardRevisions(t *testing.T) {
	ctx := context.Background()
	r := deploymentStateRepo(t)
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	first, changed, err := r.RequestRun(ctx, runStateInput(1, "one", 0, base))
	if err != nil || !changed || first.Desired.Generation != 1 || first.Desired.Action != deployment.DesiredActionRun {
		t.Fatalf("initial run = %+v changed=%v err=%v", first, changed, err)
	}
	if first.Reconcile.DueAt == nil || !first.Reconcile.DueAt.Equal(base) || first.Observed.Phase != deployment.DeploymentPhasePending {
		t.Fatalf("initial scheduling = %+v", first)
	}
	if first.Storage.Phase != deployment.StoragePhaseUnprovisioned {
		t.Fatalf("initial storage = %+v", first.Storage)
	}

	replay, changed, err := r.RequestRun(ctx, runStateInput(1, "one", 0, base.Add(time.Second)))
	if err != nil || changed || replay.Desired.Generation != 1 {
		t.Fatalf("run replay = %+v changed=%v err=%v", replay, changed, err)
	}
	redeploy, changed, err := r.RequestRun(ctx, runStateInput(1, "one", 1, base.Add(1500*time.Millisecond)))
	if err != nil || !changed || redeploy.Desired.Generation != 2 {
		t.Fatalf("same-revision redeploy = %+v changed=%v err=%v", redeploy, changed, err)
	}

	newImage := runStateInput(1, "one", 2, base.Add(2*time.Second))
	newImage.Target.RuntimeImage = "registry.example/agentflow-runtime@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	second, changed, err := r.RequestRun(ctx, newImage)
	if err != nil || !changed || second.Desired.Generation != 3 || second.Desired.Target.RuntimeImage == first.Desired.Target.RuntimeImage {
		t.Fatalf("runtime rollout = %+v changed=%v err=%v", second, changed, err)
	}
	forward := runStateInput(2, "two", 3, base.Add(3*time.Second))
	third, changed, err := r.RequestRun(ctx, forward)
	if err != nil || !changed || third.Desired.Generation != 4 || third.Desired.Target.Revision != 2 {
		t.Fatalf("forward revision = %+v changed=%v err=%v", third, changed, err)
	}

	rollback := runStateInput(1, "one", 4, base.Add(4*time.Second))
	if _, _, err := r.RequestRun(ctx, rollback); !errors.Is(err, deployment.ErrDeployStateRollback) {
		t.Fatalf("rollback error = %v", err)
	}

	deleted, changed, err := r.RequestDelete(ctx, deployment.DeleteStateInput{
		UserID: userA, DeploymentID: first.DeploymentID, ExpectedGeneration: 4, RequestedAt: base.Add(5 * time.Second),
	})
	if err != nil || !changed || deleted.Desired.Generation != 5 || deleted.Desired.Action != deployment.DesiredActionDelete {
		t.Fatalf("delete = %+v changed=%v err=%v", deleted, changed, err)
	}
	deleteReplay, changed, err := r.RequestDelete(ctx, deployment.DeleteStateInput{
		UserID: userA, DeploymentID: first.DeploymentID, ExpectedGeneration: 4, RequestedAt: base.Add(6 * time.Second),
	})
	if err != nil || changed || deleteReplay.Desired.Generation != 5 {
		t.Fatalf("delete replay = %+v changed=%v err=%v", deleteReplay, changed, err)
	}

	restart := runStateInput(2, "two", 5, base.Add(7*time.Second))
	restarted, changed, err := r.RequestRun(ctx, restart)
	if err != nil || !changed || restarted.Desired.Generation != 6 || restarted.Desired.Action != deployment.DesiredActionRun {
		t.Fatalf("redeploy = %+v changed=%v err=%v", restarted, changed, err)
	}
	if _, err := r.Get(ctx, userB, first.DeploymentID); !errors.Is(err, deployment.ErrDeployStateNotFound) {
		t.Fatalf("cross-owner Get error = %v", err)
	}
}

func TestDeploymentStateConcurrentMutationsHaveOneWinner(t *testing.T) {
	ctx := context.Background()
	r := deploymentStateRepo(t)
	base := time.Date(2026, 2, 2, 3, 4, 5, 0, time.UTC)
	if _, _, err := r.RequestRun(ctx, runStateInput(1, "one", 0, base)); err != nil {
		t.Fatal(err)
	}

	inputs := []deployment.RunStateInput{
		runStateInput(2, "two", 1, base.Add(time.Second)),
		runStateInput(3, "three", 1, base.Add(2*time.Second)),
	}
	type result struct {
		changed bool
		err     error
	}
	results := make(chan result, len(inputs))
	var wg sync.WaitGroup
	for _, input := range inputs {
		input := input
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, changed, err := r.RequestRun(ctx, input)
			results <- result{changed: changed, err: err}
		}()
	}
	wg.Wait()
	close(results)

	winners := 0
	conflicts := 0
	for result := range results {
		if result.err == nil && result.changed {
			winners++
		} else if errors.Is(result.err, deployment.ErrDeployStateConflict) || errors.Is(result.err, deployment.ErrDeployStateRollback) {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent result: %+v", result)
		}
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("winners=%d conflicts=%d", winners, conflicts)
	}
	loaded, err := r.Get(ctx, userA, inputs[0].DeploymentID)
	if err != nil || loaded.Desired.Generation != 2 {
		t.Fatalf("loaded = %+v err=%v", loaded, err)
	}
}

func TestDeploymentStateConcurrentInitialReplayConverges(t *testing.T) {
	ctx := context.Background()
	r := deploymentStateRepo(t)
	base := time.Date(2026, 2, 3, 3, 4, 5, 0, time.UTC)
	input := runStateInput(1, "same", 0, base)

	type result struct {
		state   *deployment.DeployState
		changed bool
		err     error
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			state, changed, err := r.RequestRun(ctx, input)
			results <- result{state: state, changed: changed, err: err}
		}()
	}
	wg.Wait()
	close(results)

	created := 0
	replayed := 0
	for result := range results {
		if result.err != nil || result.state == nil || result.state.Desired.Generation != 1 {
			t.Fatalf("initial concurrent result = %+v", result)
		}
		if result.changed {
			created++
		} else {
			replayed++
		}
	}
	if created != 1 || replayed != 1 {
		t.Fatalf("created=%d replayed=%d", created, replayed)
	}
}

func TestDeploymentStateClaimLeaseAndGenerationFence(t *testing.T) {
	ctx := context.Background()
	r := deploymentStateRepo(t)
	base := time.Date(2026, 3, 2, 3, 4, 5, 0, time.UTC)
	initial, _, err := r.RequestRun(ctx, runStateInput(1, "one", 0, base))
	if err != nil {
		t.Fatal(err)
	}

	claimed, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-a", Token: "claim-a", Now: base, LeaseDuration: time.Minute,
	})
	if err != nil || !ok || claimed.Reconcile.Claim == nil || claimed.Reconcile.Attempt != 1 {
		t.Fatalf("first claim = %+v ok=%v err=%v", claimed, ok, err)
	}
	if _, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-b", Token: "claim-b", Now: base.Add(30 * time.Second), LeaseDuration: time.Minute,
	}); err != nil || ok {
		t.Fatalf("claim before expiry ok=%v err=%v", ok, err)
	}
	oldClaim := claimRef(claimed)
	if applied, err := r.RecordProgress(ctx, deployment.ProgressObservation{
		Claim: oldClaim, Phase: deployment.DeploymentPhaseProvisioning, Now: base.Add(10 * time.Second),
	}); err != nil || !applied {
		t.Fatalf("RecordProgress applied=%v err=%v", applied, err)
	}

	nextInput := runStateInput(2, "two", 1, base.Add(20*time.Second))
	next, changed, err := r.RequestRun(ctx, nextInput)
	if err != nil || !changed || next.Desired.Generation != 2 || next.Reconcile.Claim != nil {
		t.Fatalf("next generation = %+v changed=%v err=%v", next, changed, err)
	}
	ready := deployment.ReadyObservation{
		Claim: oldClaim, Target: initial.Desired.Target, Endpoint: "https://old.example",
		Resources: deployment.ResourceRefs{Namespace: "agentflow-runtime", DeploymentName: "old"},
		Now:       base.Add(25 * time.Second),
	}
	if applied, err := r.RecordReady(ctx, ready); err != nil || applied {
		t.Fatalf("stale ready applied=%v err=%v", applied, err)
	}

	claimed, ok, err = r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-b", Token: "claim-b", Now: base.Add(30 * time.Second), LeaseDuration: time.Minute,
	})
	if err != nil || !ok || claimed.Reconcile.Claim.Generation != 2 {
		t.Fatalf("new generation claim = %+v ok=%v err=%v", claimed, ok, err)
	}
	currentClaim := claimRef(claimed)
	plan, err := deployment.NewStoragePlan(userA, initial.DeploymentID, nextInput.Target.Namespace)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := r.RecordStoragePlan(ctx, deployment.StoragePlanObservation{
		Claim: currentClaim, Plan: plan, Now: base.Add(31 * time.Second),
	})
	if err != nil || !applied {
		t.Fatalf("storage plan applied=%v err=%v", applied, err)
	}
	if applied, err := r.RecordStoragePlan(ctx, deployment.StoragePlanObservation{
		Claim: oldClaim, Plan: plan, Now: base.Add(32 * time.Second),
	}); err != nil || applied {
		t.Fatalf("stale storage plan applied=%v err=%v", applied, err)
	}
	if applied, err := r.RecordStorageReady(ctx, deployment.StorageReadyObservation{
		Claim: currentClaim, Binding: storageBinding(plan), Now: base.Add(35 * time.Second),
	}); err != nil || !applied {
		t.Fatalf("storage ready applied=%v err=%v", applied, err)
	}
	replacement := storageBinding(plan)
	replacement.PVCUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	if applied, err := r.RecordStorageReady(ctx, deployment.StorageReadyObservation{
		Claim: currentClaim, Binding: replacement, Now: base.Add(36 * time.Second),
	}); !errors.Is(err, deployment.ErrDeployStorageConflict) || applied {
		t.Fatalf("replacement PVC identity applied=%v err=%v", applied, err)
	}
	ready = deployment.ReadyObservation{
		Claim: currentClaim, Target: nextInput.Target, Endpoint: "https://agent.example",
		Resources: deployment.ResourceRefs{
			Namespace: "agentflow-runtime", DeploymentName: "af-agent", ServiceName: "af-agent",
			DeliverySecretName: "af-agent-delivery", RuntimeSecretName: "af-agent-runtime",
		},
		Now: base.Add(40 * time.Second),
	}
	if applied, err := r.RecordReady(ctx, ready); err != nil || !applied {
		t.Fatalf("current ready applied=%v err=%v", applied, err)
	}
	loaded, err := r.Get(ctx, userA, initial.DeploymentID)
	if err != nil || !loaded.Observed.Ready || loaded.Observed.Generation != 2 || loaded.Reconcile.DueAt != nil || loaded.Reconcile.Claim != nil {
		t.Fatalf("ready state = %+v err=%v", loaded, err)
	}

	deleted, _, err := r.RequestDelete(ctx, deployment.DeleteStateInput{
		UserID: userA, DeploymentID: initial.DeploymentID, ExpectedGeneration: 2, RequestedAt: base.Add(50 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, ok, err = r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-c", Token: "claim-c", Now: base.Add(50 * time.Second), LeaseDuration: time.Minute,
	})
	if err != nil || !ok || claimed.Desired.Action != deployment.DesiredActionDelete {
		t.Fatalf("delete claim = %+v ok=%v err=%v", claimed, ok, err)
	}
	if applied, err := r.RecordDeleted(ctx, claimRef(claimed), base.Add(time.Minute)); err != nil || !applied {
		t.Fatalf("RecordDeleted applied=%v err=%v", applied, err)
	}
	loaded, err = r.Get(ctx, userA, deleted.DeploymentID)
	if err != nil || loaded.Observed.Phase != deployment.DeploymentPhaseDeleted || loaded.Observed.Ready || loaded.Observed.Generation != 3 {
		t.Fatalf("deleted state = %+v err=%v", loaded, err)
	}
	if loaded.Storage.Phase != deployment.StoragePhaseRetained || loaded.Storage.PVCUID != storageBinding(plan).PVCUID ||
		loaded.Storage.PVCName != plan.PVCName {
		t.Fatalf("retained storage = %+v", loaded.Storage)
	}
	drift := runStateInput(3, "three", 3, base.Add(2*time.Minute))
	drift.Target.Namespace = "other-runtime"
	if _, _, err := r.RequestRun(ctx, drift); !errors.Is(err, deployment.ErrDeployStorageConflict) {
		t.Fatalf("namespace drift error = %v", err)
	}
}

func TestDeploymentStateRecordsMissingOnlyAfterVerifiedBinding(t *testing.T) {
	ctx := context.Background()
	r := deploymentStateRepo(t)
	base := time.Date(2026, 3, 3, 3, 4, 5, 0, time.UTC)
	state, _, err := r.RequestRun(ctx, runStateInput(1, "one", 0, base))
	if err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-a", Token: "claim-a", Now: base, LeaseDuration: time.Minute,
	})
	if err != nil || !ok {
		t.Fatalf("claim = %+v ok=%v err=%v", claimed, ok, err)
	}
	claim := claimRef(claimed)
	if applied, err := r.RecordStorageMissing(ctx, deployment.StorageMissingObservation{
		Claim: claim, Now: base.Add(time.Second),
	}); err != nil || applied {
		t.Fatalf("unverified storage marked missing: applied=%v err=%v", applied, err)
	}
	plan, err := deployment.NewStoragePlan(state.UserID, state.DeploymentID, state.Desired.Target.Namespace)
	if err != nil {
		t.Fatal(err)
	}
	if applied, err := r.RecordStoragePlan(ctx, deployment.StoragePlanObservation{
		Claim: claim, Plan: plan, Now: base.Add(2 * time.Second),
	}); err != nil || !applied {
		t.Fatalf("record plan: applied=%v err=%v", applied, err)
	}
	if applied, err := r.RecordStorageReady(ctx, deployment.StorageReadyObservation{
		Claim: claim, Binding: storageBinding(plan), Now: base.Add(3 * time.Second),
	}); err != nil || !applied {
		t.Fatalf("record ready: applied=%v err=%v", applied, err)
	}
	missingAt := base.Add(4 * time.Second)
	if applied, err := r.RecordStorageMissing(ctx, deployment.StorageMissingObservation{
		Claim: claim, Now: missingAt,
	}); err != nil || !applied {
		t.Fatalf("record missing: applied=%v err=%v", applied, err)
	}
	loaded, err := r.Get(ctx, state.UserID, state.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Storage.Phase != deployment.StoragePhaseMissing || !loaded.Storage.LastObservedAt.Equal(missingAt) || loaded.Storage.PVCUID == "" {
		t.Fatalf("missing storage state = %+v", loaded.Storage)
	}
}

func TestDeploymentStateFailureRetryAndExpiredLease(t *testing.T) {
	ctx := context.Background()
	r := deploymentStateRepo(t)
	base := time.Date(2026, 4, 2, 3, 4, 5, 0, time.UTC)
	state, _, err := r.RequestRun(ctx, runStateInput(1, "one", 0, base))
	if err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-a", Token: "claim-a", Now: base, LeaseDuration: time.Minute,
	})
	if err != nil || !ok {
		t.Fatalf("claim = %+v ok=%v err=%v", claimed, ok, err)
	}
	firstClaim := claimRef(claimed)
	if refreshed, err := r.RefreshClaim(ctx, firstClaim, base.Add(time.Minute), time.Minute); err != nil || refreshed {
		t.Fatalf("expired refresh refreshed=%v err=%v", refreshed, err)
	}

	reclaimed, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-b", Token: "claim-b", Now: base.Add(time.Minute), LeaseDuration: time.Minute,
	})
	if err != nil || !ok || reclaimed.Reconcile.Attempt != 2 {
		t.Fatalf("reclaim = %+v ok=%v err=%v", reclaimed, ok, err)
	}
	if applied, err := r.RecordProgress(ctx, deployment.ProgressObservation{
		Claim: firstClaim, Phase: deployment.DeploymentPhaseStarting, Now: base.Add(time.Minute + time.Second),
	}); err != nil || applied {
		t.Fatalf("expired claimant progress applied=%v err=%v", applied, err)
	}

	retryAt := base.Add(3 * time.Minute)
	if applied, err := r.RecordFailure(ctx, deployment.FailureObservation{
		Claim: claimRef(reclaimed), Code: "kubernetes_unavailable", Message: "kubernetes api unavailable",
		Retryable: true, RetryAt: retryAt, OccurredAt: base.Add(90 * time.Second),
	}); err != nil || !applied {
		t.Fatalf("retryable failure applied=%v err=%v", applied, err)
	}
	loaded, err := r.Get(ctx, userA, state.DeploymentID)
	if err != nil || loaded.Observed.Phase != deployment.DeploymentPhaseFailed || loaded.Observed.LastError == nil ||
		loaded.Reconcile.DueAt == nil || !loaded.Reconcile.DueAt.Equal(retryAt) || loaded.Reconcile.ProcessedGeneration != 0 {
		t.Fatalf("retry state = %+v err=%v", loaded, err)
	}
	if _, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-c", Token: "claim-c", Now: retryAt.Add(-time.Millisecond), LeaseDuration: time.Minute,
	}); err != nil || ok {
		t.Fatalf("early retry claim ok=%v err=%v", ok, err)
	}
	retryClaim, ok, err := r.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: "controller-c", Token: "claim-c", Now: retryAt, LeaseDuration: time.Minute,
	})
	if err != nil || !ok || retryClaim.Reconcile.Attempt != 3 {
		t.Fatalf("retry claim = %+v ok=%v err=%v", retryClaim, ok, err)
	}
	if applied, err := r.RecordFailure(ctx, deployment.FailureObservation{
		Claim: claimRef(retryClaim), Code: "invalid_bundle", Message: "bundle rejected by runtime",
		OccurredAt: retryAt.Add(10 * time.Second),
	}); err != nil || !applied {
		t.Fatalf("terminal failure applied=%v err=%v", applied, err)
	}
	loaded, err = r.Get(ctx, userA, state.DeploymentID)
	if err != nil || loaded.Reconcile.DueAt != nil || loaded.Reconcile.ProcessedGeneration != 1 || loaded.Observed.LastError == nil || loaded.Observed.LastError.Retryable {
		t.Fatalf("terminal state = %+v err=%v", loaded, err)
	}
}

func TestDeploymentStateLegacyMigrationIsExplicit(t *testing.T) {
	ctx := context.Background()
	statesCol := col(t, "deployment_states")
	r := mongorepo.NewDeploymentStateRepo(statesCol)
	if err := r.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 5, 2, 3, 4, 5, 0, time.UTC)
	target := deploymentTarget(7, "legacy")
	legacyName := "af-legacy-r7-aaaaaaaaaaaa"
	uid, _ := bson.ObjectIDFromHex(userA)
	if _, err := statesCol.InsertOne(ctx, bson.M{
		"_id": bson.NewObjectID(), "user_id": uid, "deployment_id": "legacy",
		"revision": target.Revision, "config_hash": target.ConfigHash, "resource_name": legacyName,
		"created_at": base, "updated_at": base,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(ctx, userA, "legacy"); !errors.Is(err, deployment.ErrDeployStateMigrationRequired) {
		t.Fatalf("legacy Get error = %v", err)
	}
	source, err := r.InspectMigrationSource(ctx, userA, "legacy")
	if err != nil || source.RecordVersion != 0 || source.LegacyRevision != target.Revision ||
		source.LegacyConfigHash != target.ConfigHash || source.LegacyResourceName != legacyName {
		t.Fatalf("legacy migration source = %+v err=%v", source, err)
	}

	migrated, err := r.MigrateLegacy(ctx, deployment.LegacyStateMigration{
		UserID: userA, DeploymentID: "legacy", Target: target,
		LegacyResourceName: legacyName, MigratedAt: base.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if migrated.RecordVersion != deployment.DeployStateRecordVersion || migrated.Desired.Generation != 1 ||
		migrated.Observed.Generation != 0 || migrated.Observed.Phase != deployment.DeploymentPhasePending ||
		migrated.Storage.Phase != deployment.StoragePhaseUnprovisioned ||
		migrated.Migration == nil || migrated.Migration.LegacyResourceName != legacyName || migrated.Reconcile.DueAt == nil {
		t.Fatalf("migrated state = %+v", migrated)
	}
	var raw bson.M
	if err := statesCol.FindOne(ctx, bson.M{"user_id": uid, "deployment_id": "legacy"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, obsolete := range []string{"revision", "config_hash", "resource_name"} {
		if _, exists := raw[obsolete]; exists {
			t.Fatalf("legacy field %q remains in %+v", obsolete, raw)
		}
	}
}

func TestDeploymentStateV2MigrationRequiresPVCVerification(t *testing.T) {
	ctx := context.Background()
	statesCol := col(t, "deployment_states")
	r := mongorepo.NewDeploymentStateRepo(statesCol)
	if err := r.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 6, 2, 3, 4, 5, 0, time.UTC)
	target := deploymentTarget(4, "v2")
	uid, _ := bson.ObjectIDFromHex(userA)
	deploymentID := "507f1f77bcf86cd799439077"
	legacyPVC := "af-agent-r4-aaaaaaaaaaaa"
	if _, err := statesCol.InsertOne(ctx, bson.M{
		"_id": bson.NewObjectID(), "record_version": deployment.PreviousDeployStateRecordVersion,
		"user_id": uid, "deployment_id": deploymentID,
		"desired": bson.M{
			"generation": int64(3), "action": string(deployment.DesiredActionRun),
			"target": bson.M{
				"revision": target.Revision, "config_hash": target.ConfigHash,
				"schema_version": target.SchemaVersion, "namespace": target.Namespace,
				"runtime_image": target.RuntimeImage,
			},
			"requested_at": base,
		},
		"observed": bson.M{
			"phase": string(deployment.DeploymentPhaseReady), "ready": true,
			"resources": bson.M{"namespace": target.Namespace, "state_pvc_name": legacyPVC},
		},
		"reconcile": bson.M{}, "created_at": base, "updated_at": base,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(ctx, userA, deploymentID); !errors.Is(err, deployment.ErrDeployStateMigrationRequired) {
		t.Fatalf("v2 Get error = %v", err)
	}
	source, err := r.InspectMigrationSource(ctx, userA, deploymentID)
	if err != nil || source.RecordVersion != deployment.PreviousDeployStateRecordVersion ||
		source.DesiredTarget != target || source.LegacyPVCName != legacyPVC || source.LegacyPVCNamespace != target.Namespace {
		t.Fatalf("v2 migration source = %+v err=%v", source, err)
	}

	migrated, err := r.MigrateV2(ctx, deployment.V2StateMigration{
		UserID: userA, DeploymentID: deploymentID, MigratedAt: base.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := deployment.NewStoragePlan(userA, deploymentID, target.Namespace)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.RecordVersion != deployment.DeployStateRecordVersion ||
		migrated.Storage.Phase != deployment.StoragePhaseMigrationRequired ||
		migrated.Storage.StorageID != plan.StorageID || migrated.Storage.PVCName != plan.PVCName ||
		migrated.Storage.LegacyPVCName != legacyPVC || migrated.Storage.LegacyPVCNamespace != target.Namespace ||
		migrated.Storage.PVCUID != "" {
		t.Fatalf("migrated v2 storage = %+v", migrated.Storage)
	}
	legacyFields, err := statesCol.CountDocuments(ctx, bson.M{
		"user_id": uid, "deployment_id": deploymentID,
		"observed.resources.state_pvc_name": bson.M{"$exists": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacyFields != 0 {
		t.Fatalf("legacy PVC remains generation-scoped in %d document(s)", legacyFields)
	}
}
