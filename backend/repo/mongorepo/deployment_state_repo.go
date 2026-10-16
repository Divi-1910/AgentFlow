package mongorepo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"backend/deployment"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type DeploymentStateRepo struct {
	states *mongo.Collection
}

func NewDeploymentStateRepo(states *mongo.Collection) *DeploymentStateRepo {
	return &DeploymentStateRepo{states: states}
}

type deploymentTargetBSON struct {
	Revision      int    `bson:"revision"`
	ConfigHash    string `bson:"config_hash"`
	SchemaVersion int    `bson:"schema_version"`
	Namespace     string `bson:"namespace"`
	RuntimeImage  string `bson:"runtime_image"`
}

type desiredStateBSON struct {
	Generation  int64                `bson:"generation"`
	Action      string               `bson:"action"`
	Target      deploymentTargetBSON `bson:"target"`
	RequestedAt time.Time            `bson:"requested_at"`
}

type resourceRefsBSON struct {
	Namespace          string `bson:"namespace,omitempty"`
	DeploymentName     string `bson:"deployment_name,omitempty"`
	ServiceName        string `bson:"service_name,omitempty"`
	LegacyStatePVCName string `bson:"state_pvc_name,omitempty"`
	DeliverySecretName string `bson:"delivery_secret_name,omitempty"`
	RuntimeSecretName  string `bson:"runtime_secret_name,omitempty"`
}

type storageStateBSON struct {
	Phase                  string    `bson:"phase"`
	StorageID              string    `bson:"storage_id,omitempty"`
	Namespace              string    `bson:"namespace,omitempty"`
	PVCName                string    `bson:"pvc_name,omitempty"`
	RequestedCapacityBytes int64     `bson:"requested_capacity_bytes,omitempty"`
	AccessMode             string    `bson:"access_mode,omitempty"`
	VolumeMode             string    `bson:"volume_mode,omitempty"`
	StorageClassPolicy     string    `bson:"storage_class_policy,omitempty"`
	PVCUID                 string    `bson:"pvc_uid,omitempty"`
	StorageClassName       string    `bson:"storage_class_name,omitempty"`
	CapacityBytes          int64     `bson:"capacity_bytes,omitempty"`
	LegacyPVCName          string    `bson:"legacy_pvc_name,omitempty"`
	LegacyPVCNamespace     string    `bson:"legacy_pvc_namespace,omitempty"`
	PlannedAt              time.Time `bson:"planned_at,omitempty"`
	LastObservedAt         time.Time `bson:"last_observed_at,omitempty"`
}

type deploymentErrorBSON struct {
	Code       string    `bson:"code"`
	Message    string    `bson:"message"`
	Retryable  bool      `bson:"retryable"`
	Generation int64     `bson:"generation"`
	OccurredAt time.Time `bson:"occurred_at"`
}

type observedStateBSON struct {
	Generation       int64                 `bson:"generation"`
	Phase            string                `bson:"phase"`
	Target           *deploymentTargetBSON `bson:"target,omitempty"`
	Ready            bool                  `bson:"ready"`
	Endpoint         string                `bson:"endpoint,omitempty"`
	Resources        resourceRefsBSON      `bson:"resources,omitempty"`
	LastError        *deploymentErrorBSON  `bson:"last_error,omitempty"`
	LastTransitionAt time.Time             `bson:"last_transition_at,omitempty"`
}

type reconcileClaimBSON struct {
	Generation     int64     `bson:"generation"`
	Token          string    `bson:"token"`
	Owner          string    `bson:"owner"`
	LeaseExpiresAt time.Time `bson:"lease_expires_at"`
}

type reconcileStateBSON struct {
	DueAt               *time.Time          `bson:"due_at,omitempty"`
	Attempt             int                 `bson:"attempt"`
	ProcessedGeneration int64               `bson:"processed_generation"`
	Claim               *reconcileClaimBSON `bson:"claim,omitempty"`
}

type migrationStateBSON struct {
	LegacyResourceName string    `bson:"legacy_resource_name,omitempty"`
	MigratedAt         time.Time `bson:"migrated_at"`
}

type deploymentStateBSON struct {
	ID            bson.ObjectID       `bson:"_id,omitempty"`
	RecordVersion int                 `bson:"record_version,omitempty"`
	UserID        bson.ObjectID       `bson:"user_id"`
	DeploymentID  string              `bson:"deployment_id"`
	Desired       desiredStateBSON    `bson:"desired,omitempty"`
	Observed      observedStateBSON   `bson:"observed,omitempty"`
	Storage       storageStateBSON    `bson:"storage,omitempty"`
	Reconcile     reconcileStateBSON  `bson:"reconcile,omitempty"`
	Migration     *migrationStateBSON `bson:"migration,omitempty"`
	CreatedAt     time.Time           `bson:"created_at"`
	UpdatedAt     time.Time           `bson:"updated_at"`

	// Legacy version-1 fields are decoded only so migration can verify them.
	Revision     int    `bson:"revision,omitempty"`
	ConfigHash   string `bson:"config_hash,omitempty"`
	ResourceName string `bson:"resource_name,omitempty"`
}

func (r *DeploymentStateRepo) EnsureIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "user_id", Value: 1}, {Key: "deployment_id", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("deployment_states_owner_deployment_unique"),
		},
		{
			Keys: bson.D{
				{Key: "record_version", Value: 1},
				{Key: "reconcile.due_at", Value: 1},
				{Key: "reconcile.claim.lease_expires_at", Value: 1},
				{Key: "created_at", Value: 1},
			},
			Options: options.Index().
				SetName("deployment_states_v3_due_claim").
				SetPartialFilterExpression(bson.D{
					{Key: "record_version", Value: deployment.DeployStateRecordVersion},
					{Key: "reconcile.due_at", Value: bson.D{{Key: "$type", Value: "date"}}},
				}),
		},
	}
	if _, err := r.states.Indexes().CreateMany(ctx, indexes); err != nil {
		return fmt.Errorf("deployment_state_repo: indexes: %w", err)
	}
	return nil
}

func (r *DeploymentStateRepo) RequestRun(ctx context.Context, input deployment.RunStateInput) (*deployment.DeployState, bool, error) {
	uid, now, err := validateRunStateInput(input)
	if err != nil {
		return nil, false, err
	}

	var existing deploymentStateBSON
	err = r.states.FindOne(ctx, ownerDeploymentFilter(uid, input.DeploymentID)).Decode(&existing)
	if err == mongo.ErrNoDocuments {
		if input.ExpectedGeneration != 0 {
			return nil, false, deployment.ErrDeployStateConflict
		}
		raw := deploymentStateBSON{
			ID: bson.NewObjectID(), RecordVersion: deployment.DeployStateRecordVersion,
			UserID: uid, DeploymentID: input.DeploymentID,
			Desired: desiredStateBSON{
				Generation: 1, Action: string(deployment.DesiredActionRun),
				Target: targetToBSON(input.Target), RequestedAt: now,
			},
			Observed:  observedStateBSON{Phase: string(deployment.DeploymentPhasePending)},
			Storage:   storageStateBSON{Phase: string(deployment.StoragePhaseUnprovisioned)},
			Reconcile: reconcileStateBSON{DueAt: timePtr(now)},
			CreatedAt: now, UpdatedAt: now,
		}
		if _, insertErr := r.states.InsertOne(ctx, raw); insertErr == nil {
			return toDeployState(raw), true, nil
		} else if !mongo.IsDuplicateKeyError(insertErr) {
			return nil, false, fmt.Errorf("deployment_state_repo: request initial run: %w", insertErr)
		}
		if err := r.states.FindOne(ctx, ownerDeploymentFilter(uid, input.DeploymentID)).Decode(&existing); err != nil {
			return nil, false, fmt.Errorf("deployment_state_repo: load concurrent initial run: %w", err)
		}
	} else if err != nil {
		return nil, false, fmt.Errorf("deployment_state_repo: load before run request: %w", err)
	}

	if existing.RecordVersion != deployment.DeployStateRecordVersion {
		return nil, false, deployment.ErrDeployStateMigrationRequired
	}
	if existing.Storage.Phase != string(deployment.StoragePhaseUnprovisioned) &&
		existing.Storage.Namespace != input.Target.Namespace {
		return nil, false, deployment.ErrDeployStorageConflict
	}
	if sameRunTarget(existing.Desired, input.Target) &&
		existing.Desired.Generation > 0 && input.ExpectedGeneration == existing.Desired.Generation-1 {
		return toDeployState(existing), false, nil
	}
	if input.Target.Revision < existing.Desired.Target.Revision {
		return nil, false, deployment.ErrDeployStateRollback
	}
	if input.Target.Revision == existing.Desired.Target.Revision &&
		(input.Target.ConfigHash != existing.Desired.Target.ConfigHash || input.Target.SchemaVersion != existing.Desired.Target.SchemaVersion) {
		return nil, false, deployment.ErrDeployStateConflict
	}
	if input.ExpectedGeneration != existing.Desired.Generation {
		return nil, false, deployment.ErrDeployStateConflict
	}

	filter := ownerDeploymentFilter(uid, input.DeploymentID)
	filter["record_version"] = deployment.DeployStateRecordVersion
	filter["desired.generation"] = input.ExpectedGeneration
	filter["desired.target.revision"] = bson.M{"$lte": input.Target.Revision}
	filter["$or"] = bson.A{
		bson.M{"storage.phase": string(deployment.StoragePhaseUnprovisioned)},
		bson.M{"storage.namespace": input.Target.Namespace},
	}
	update := bson.M{
		"$set": bson.M{
			"desired": desiredStateBSON{
				Generation: input.ExpectedGeneration + 1, Action: string(deployment.DesiredActionRun),
				Target: targetToBSON(input.Target), RequestedAt: now,
			},
			"reconcile.due_at":  now,
			"reconcile.attempt": 0,
			"updated_at":        now,
		},
		"$unset": bson.M{"reconcile.claim": "", "observed.last_error": ""},
	}
	return r.findOneAndUpdate(ctx, filter, update, "request run")
}

func (r *DeploymentStateRepo) RequestDelete(ctx context.Context, input deployment.DeleteStateInput) (*deployment.DeployState, bool, error) {
	uid, err := ownedDeployment(input.UserID, input.DeploymentID)
	if err != nil {
		return nil, false, err
	}
	if input.ExpectedGeneration <= 0 {
		return nil, false, deployment.ErrDeployStateConflict
	}
	now := normalizedTime(input.RequestedAt)

	var existing deploymentStateBSON
	err = r.states.FindOne(ctx, ownerDeploymentFilter(uid, input.DeploymentID)).Decode(&existing)
	if err == mongo.ErrNoDocuments {
		return nil, false, deployment.ErrDeployStateNotFound
	}
	if err != nil {
		return nil, false, fmt.Errorf("deployment_state_repo: load before delete request: %w", err)
	}
	if existing.RecordVersion != deployment.DeployStateRecordVersion {
		return nil, false, deployment.ErrDeployStateMigrationRequired
	}
	if existing.Desired.Action == string(deployment.DesiredActionDelete) && replayGeneration(input.ExpectedGeneration, existing.Desired.Generation) {
		return toDeployState(existing), false, nil
	}
	if input.ExpectedGeneration != existing.Desired.Generation {
		return nil, false, deployment.ErrDeployStateConflict
	}

	filter := ownerDeploymentFilter(uid, input.DeploymentID)
	filter["record_version"] = deployment.DeployStateRecordVersion
	filter["desired.generation"] = input.ExpectedGeneration
	update := bson.M{
		"$set": bson.M{
			"desired.generation":   input.ExpectedGeneration + 1,
			"desired.action":       string(deployment.DesiredActionDelete),
			"desired.requested_at": now,
			"reconcile.due_at":     now,
			"reconcile.attempt":    0,
			"updated_at":           now,
		},
		"$unset": bson.M{"reconcile.claim": "", "observed.last_error": ""},
	}
	return r.findOneAndUpdate(ctx, filter, update, "request delete")
}

func (r *DeploymentStateRepo) Get(ctx context.Context, userID, deploymentID string) (*deployment.DeployState, error) {
	uid, err := ownedDeployment(userID, deploymentID)
	if err != nil {
		return nil, err
	}
	var raw deploymentStateBSON
	err = r.states.FindOne(ctx, ownerDeploymentFilter(uid, deploymentID)).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, deployment.ErrDeployStateNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: get: %w", err)
	}
	if raw.RecordVersion != deployment.DeployStateRecordVersion {
		return nil, deployment.ErrDeployStateMigrationRequired
	}
	return toDeployState(raw), nil
}

// InspectMigrationSource reads legacy evidence without migrating it. Normal
// deployment reads continue to fail closed for unsupported record versions.
func (r *DeploymentStateRepo) InspectMigrationSource(ctx context.Context, userID, deploymentID string) (*deployment.StateMigrationSource, error) {
	uid, err := ownedDeployment(userID, deploymentID)
	if err != nil {
		return nil, err
	}
	var raw deploymentStateBSON
	if err := r.states.FindOne(ctx, ownerDeploymentFilter(uid, deploymentID)).Decode(&raw); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, deployment.ErrDeployStateNotFound
		}
		return nil, fmt.Errorf("deployment_state_repo: inspect migration source: %w", err)
	}
	return &deployment.StateMigrationSource{
		RecordVersion: raw.RecordVersion, UserID: userID, DeploymentID: deploymentID,
		LegacyRevision: raw.Revision, LegacyConfigHash: raw.ConfigHash, LegacyResourceName: raw.ResourceName,
		DesiredTarget:      targetFromBSON(raw.Desired.Target),
		LegacyPVCName:      raw.Observed.Resources.LegacyStatePVCName,
		LegacyPVCNamespace: raw.Observed.Resources.Namespace,
	}, nil
}

func (r *DeploymentStateRepo) ClaimDue(ctx context.Context, request deployment.ClaimRequest) (*deployment.DeployState, bool, error) {
	if err := deployment.ValidateClaimIdentity(request.Owner, request.Token); err != nil {
		return nil, false, err
	}
	if request.LeaseDuration <= 0 {
		return nil, false, fmt.Errorf("%w: lease duration must be positive", deployment.ErrDeployStateClaim)
	}
	now := normalizedTime(request.Now)
	expires := now.Add(request.LeaseDuration)
	filter := bson.M{
		"record_version":   deployment.DeployStateRecordVersion,
		"reconcile.due_at": bson.M{"$lte": now},
		"$or": bson.A{
			bson.M{"reconcile.claim": bson.M{"$exists": false}},
			bson.M{"reconcile.claim.lease_expires_at": bson.M{"$lte": now}},
		},
	}
	update := mongo.Pipeline{bson.D{{Key: "$set", Value: bson.D{
		{Key: "reconcile.claim", Value: bson.D{
			{Key: "generation", Value: "$desired.generation"},
			{Key: "token", Value: request.Token},
			{Key: "owner", Value: request.Owner},
			{Key: "lease_expires_at", Value: expires},
		}},
		{Key: "reconcile.attempt", Value: bson.D{{Key: "$add", Value: bson.A{
			bson.D{{Key: "$ifNull", Value: bson.A{"$reconcile.attempt", 0}}}, 1,
		}}}},
		{Key: "updated_at", Value: now},
	}}}}
	opts := options.FindOneAndUpdate().
		SetSort(bson.D{{Key: "reconcile.due_at", Value: 1}, {Key: "created_at", Value: 1}}).
		SetReturnDocument(options.After)
	var raw deploymentStateBSON
	err := r.states.FindOneAndUpdate(ctx, filter, update, opts).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("deployment_state_repo: claim due deployment: %w", err)
	}
	return toDeployState(raw), true, nil
}

func (r *DeploymentStateRepo) RefreshClaim(ctx context.Context, claim deployment.ClaimRef, now time.Time, lease time.Duration) (bool, error) {
	if lease <= 0 {
		return false, fmt.Errorf("%w: lease duration must be positive", deployment.ErrDeployStateClaim)
	}
	filter, normalized, err := r.claimFilter(claim, now)
	if err != nil {
		return false, err
	}
	res, err := r.states.UpdateOne(ctx, filter, bson.M{"$set": bson.M{
		"reconcile.claim.lease_expires_at": normalized.Add(lease),
		"updated_at":                       normalized,
	}})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: refresh claim: %w", err)
	}
	return res.MatchedCount == 1, nil
}

func (r *DeploymentStateRepo) RecordStoragePlan(
	ctx context.Context,
	observation deployment.StoragePlanObservation,
) (bool, error) {
	if err := deployment.ValidateStoragePlan(observation.Plan); err != nil {
		return false, err
	}
	filter, now, err := r.claimFilter(observation.Claim, observation.Now)
	if err != nil {
		return false, err
	}
	claimFilter := cloneFilter(filter)
	filter["desired.action"] = string(deployment.DesiredActionRun)
	filter["desired.target.namespace"] = observation.Plan.Namespace
	filter["$or"] = bson.A{
		bson.M{"storage.phase": string(deployment.StoragePhaseUnprovisioned)},
		storagePlanFilter(observation.Plan),
	}

	isUnprovisioned := bson.D{{Key: "$eq", Value: bson.A{"$storage.phase", string(deployment.StoragePhaseUnprovisioned)}}}
	update := mongo.Pipeline{bson.D{{Key: "$set", Value: bson.D{
		{Key: "storage.phase", Value: bson.D{{Key: "$cond", Value: bson.A{
			isUnprovisioned, string(deployment.StoragePhasePlanned), "$storage.phase",
		}}}},
		{Key: "storage.storage_id", Value: observation.Plan.StorageID},
		{Key: "storage.namespace", Value: observation.Plan.Namespace},
		{Key: "storage.pvc_name", Value: observation.Plan.PVCName},
		{Key: "storage.requested_capacity_bytes", Value: observation.Plan.RequestedCapacityBytes},
		{Key: "storage.access_mode", Value: string(observation.Plan.AccessMode)},
		{Key: "storage.volume_mode", Value: string(observation.Plan.VolumeMode)},
		{Key: "storage.storage_class_policy", Value: string(observation.Plan.StorageClassPolicy)},
		{Key: "storage.planned_at", Value: bson.D{{Key: "$cond", Value: bson.A{
			isUnprovisioned, now, "$storage.planned_at",
		}}}},
		{Key: "updated_at", Value: now},
	}}}}
	res, err := r.states.UpdateOne(ctx, filter, update)
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record storage plan: %w", err)
	}
	if res.MatchedCount == 1 {
		return true, nil
	}
	owned, err := r.claimMatches(ctx, claimFilter)
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: inspect rejected storage plan: %w", err)
	}
	if owned {
		return false, deployment.ErrDeployStorageConflict
	}
	return false, nil
}

func (r *DeploymentStateRepo) RecordStorageReady(
	ctx context.Context,
	observation deployment.StorageReadyObservation,
) (bool, error) {
	if err := deployment.ValidateStorageBinding(observation.Binding); err != nil {
		return false, err
	}
	filter, now, err := r.claimFilter(observation.Claim, observation.Now)
	if err != nil {
		return false, err
	}
	claimFilter := cloneFilter(filter)
	filter["desired.action"] = string(deployment.DesiredActionRun)
	filter["storage.phase"] = bson.M{"$in": bson.A{
		string(deployment.StoragePhasePlanned),
		string(deployment.StoragePhaseReady),
		string(deployment.StoragePhaseRetained),
	}}
	for key, value := range storagePlanFilter(deployment.StoragePlan{
		StorageID:              observation.Binding.StorageID,
		Namespace:              observation.Binding.Namespace,
		PVCName:                observation.Binding.PVCName,
		RequestedCapacityBytes: deployment.DefaultStorageCapacityBytes,
		AccessMode:             observation.Binding.AccessMode,
		VolumeMode:             observation.Binding.VolumeMode,
		StorageClassPolicy:     deployment.StorageClassPolicyClusterDefault,
	}) {
		filter[key] = value
	}
	filter["$and"] = bson.A{
		bson.M{"$or": bson.A{
			bson.M{"storage.pvc_uid": bson.M{"$exists": false}},
			bson.M{"storage.pvc_uid": ""},
			bson.M{"storage.pvc_uid": observation.Binding.PVCUID},
		}},
		bson.M{"$or": bson.A{
			bson.M{"storage.storage_class_name": bson.M{"$exists": false}},
			bson.M{"storage.storage_class_name": ""},
			bson.M{"storage.storage_class_name": observation.Binding.StorageClassName},
		}},
	}
	res, err := r.states.UpdateOne(ctx, filter, bson.M{"$set": bson.M{
		"storage.phase":              string(deployment.StoragePhaseReady),
		"storage.pvc_uid":            observation.Binding.PVCUID,
		"storage.storage_class_name": observation.Binding.StorageClassName,
		"storage.capacity_bytes":     observation.Binding.CapacityBytes,
		"storage.last_observed_at":   now,
		"updated_at":                 now,
	}})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record storage ready: %w", err)
	}
	if res.MatchedCount == 1 {
		return true, nil
	}
	owned, err := r.claimMatches(ctx, claimFilter)
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: inspect rejected storage readiness: %w", err)
	}
	if owned {
		return false, deployment.ErrDeployStorageConflict
	}
	return false, nil
}

// RecordStorageMissing durably marks the loss of storage which had previously
// been verified. Planned storage is intentionally excluded: an absent planned
// PVC is expected to be created by the Kubernetes adapter, while an absent
// ready or retained PVC is a data-safety incident.
func (r *DeploymentStateRepo) RecordStorageMissing(
	ctx context.Context,
	observation deployment.StorageMissingObservation,
) (bool, error) {
	filter, now, err := r.claimFilter(observation.Claim, observation.Now)
	if err != nil {
		return false, err
	}
	filter["desired.action"] = string(deployment.DesiredActionRun)
	filter["storage.phase"] = bson.M{"$in": bson.A{
		string(deployment.StoragePhaseReady),
		string(deployment.StoragePhaseRetained),
	}}
	filter["storage.pvc_uid"] = bson.M{"$type": "string", "$ne": ""}
	res, err := r.states.UpdateOne(ctx, filter, bson.M{"$set": bson.M{
		"storage.phase":            string(deployment.StoragePhaseMissing),
		"storage.last_observed_at": now,
		"updated_at":               now,
	}})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record storage missing: %w", err)
	}
	return res.MatchedCount == 1, nil
}

func (r *DeploymentStateRepo) RecordProgress(ctx context.Context, observation deployment.ProgressObservation) (bool, error) {
	if err := deployment.ValidateProgressPhase(observation.Phase); err != nil {
		return false, err
	}
	filter, now, err := r.claimFilter(observation.Claim, observation.Now)
	if err != nil {
		return false, err
	}
	res, err := r.states.UpdateOne(ctx, filter, bson.M{"$set": bson.M{
		"observed.phase":              string(observation.Phase),
		"observed.ready":              observation.Ready,
		"observed.last_transition_at": now,
		"updated_at":                  now,
	}})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record progress: %w", err)
	}
	return res.MatchedCount == 1, nil
}

func (r *DeploymentStateRepo) RecordReady(ctx context.Context, observation deployment.ReadyObservation) (bool, error) {
	if err := deployment.ValidateDeploymentTarget(observation.Target); err != nil {
		return false, err
	}
	filter, now, err := r.claimFilter(observation.Claim, observation.Now)
	if err != nil {
		return false, err
	}
	filter["storage.phase"] = string(deployment.StoragePhaseReady)
	addTargetFilter(filter, observation.Target)
	set := bson.M{
		"observed.generation":            observation.Claim.Generation,
		"observed.phase":                 string(deployment.DeploymentPhaseReady),
		"observed.target":                targetToBSON(observation.Target),
		"observed.ready":                 true,
		"observed.endpoint":              strings.TrimSpace(observation.Endpoint),
		"observed.resources":             resourcesToBSON(observation.Resources),
		"observed.last_transition_at":    now,
		"reconcile.processed_generation": observation.Claim.Generation,
		"updated_at":                     now,
	}
	res, err := r.states.UpdateOne(ctx, filter, bson.M{
		"$set":   set,
		"$unset": bson.M{"observed.last_error": "", "reconcile.due_at": "", "reconcile.claim": ""},
	})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record ready: %w", err)
	}
	return res.MatchedCount == 1, nil
}

func (r *DeploymentStateRepo) RecordFailure(ctx context.Context, observation deployment.FailureObservation) (bool, error) {
	if err := deployment.ValidateDeploymentError(observation.Code, observation.Message); err != nil {
		return false, err
	}
	filter, now, err := r.claimFilter(observation.Claim, observation.OccurredAt)
	if err != nil {
		return false, err
	}
	if observation.Retryable && !observation.RetryAt.After(now) {
		return false, fmt.Errorf("%w: retry time must be after the failure time", deployment.ErrDeployStateConflict)
	}
	lastError := deploymentErrorBSON{
		Code: observation.Code, Message: observation.Message, Retryable: observation.Retryable,
		Generation: observation.Claim.Generation, OccurredAt: now,
	}
	set := bson.M{
		"observed.phase":              string(deployment.DeploymentPhaseFailed),
		"observed.last_error":         lastError,
		"observed.last_transition_at": now,
		"updated_at":                  now,
	}
	unset := bson.M{"reconcile.claim": ""}
	if observation.Retryable {
		set["reconcile.due_at"] = normalizedTime(observation.RetryAt)
	} else {
		set["reconcile.processed_generation"] = observation.Claim.Generation
		unset["reconcile.due_at"] = ""
	}
	update := bson.M{"$set": set, "$unset": unset}

	degradedFilter := cloneFilter(filter)
	degradedFilter["observed.ready"] = true
	degradedSet := cloneMap(set)
	degradedSet["observed.phase"] = string(deployment.DeploymentPhaseDegraded)
	res, err := r.states.UpdateOne(ctx, degradedFilter, bson.M{"$set": degradedSet, "$unset": unset})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record degraded failure: %w", err)
	}
	if res.MatchedCount == 1 {
		return true, nil
	}
	failedFilter := cloneFilter(filter)
	failedFilter["observed.ready"] = bson.M{"$ne": true}
	res, err = r.states.UpdateOne(ctx, failedFilter, update)
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record failure: %w", err)
	}
	return res.MatchedCount == 1, nil
}

func (r *DeploymentStateRepo) RecordDeleted(ctx context.Context, claim deployment.ClaimRef, now time.Time) (bool, error) {
	filter, normalized, err := r.claimFilter(claim, now)
	if err != nil {
		return false, err
	}
	filter["desired.action"] = string(deployment.DesiredActionDelete)
	set := bson.M{
		"observed.generation":            claim.Generation,
		"observed.phase":                 string(deployment.DeploymentPhaseDeleted),
		"observed.ready":                 false,
		"observed.last_transition_at":    normalized,
		"reconcile.processed_generation": claim.Generation,
		"updated_at":                     normalized,
	}
	update := bson.M{
		"$set": set,
		"$unset": bson.M{
			"observed.target": "", "observed.endpoint": "", "observed.resources": "", "observed.last_error": "",
			"reconcile.due_at": "", "reconcile.claim": "",
		},
	}

	retainedFilter := cloneFilter(filter)
	retainedFilter["storage.phase"] = bson.M{"$in": bson.A{
		string(deployment.StoragePhaseReady),
		string(deployment.StoragePhaseRetained),
	}}
	retainedSet := cloneMap(set)
	retainedSet["storage.phase"] = string(deployment.StoragePhaseRetained)
	res, err := r.states.UpdateOne(ctx, retainedFilter, bson.M{
		"$set":   retainedSet,
		"$unset": update["$unset"],
	})
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record retained deletion: %w", err)
	}
	if res.MatchedCount == 1 {
		return true, nil
	}

	res, err = r.states.UpdateOne(ctx, filter, update)
	if err != nil {
		return false, fmt.Errorf("deployment_state_repo: record deleted: %w", err)
	}
	return res.MatchedCount == 1, nil
}

// MigrateLegacy explicitly converts the old flat selected-revision document.
// Reads never invoke this method: migration is an operator-visible write.
func (r *DeploymentStateRepo) MigrateLegacy(ctx context.Context, migration deployment.LegacyStateMigration) (*deployment.DeployState, error) {
	uid, err := ownedDeployment(migration.UserID, migration.DeploymentID)
	if err != nil {
		return nil, err
	}
	if err := deployment.ValidateDeploymentTarget(migration.Target); err != nil {
		return nil, err
	}
	now := normalizedTime(migration.MigratedAt)
	filter := ownerDeploymentFilter(uid, migration.DeploymentID)
	filter["$or"] = bson.A{
		bson.M{"record_version": bson.M{"$exists": false}},
		bson.M{"record_version": 0},
	}
	filter["revision"] = migration.Target.Revision
	filter["config_hash"] = migration.Target.ConfigHash
	if migration.LegacyResourceName != "" {
		filter["resource_name"] = migration.LegacyResourceName
	}
	update := bson.M{
		"$set": bson.M{
			"record_version": deployment.DeployStateRecordVersion,
			"desired": desiredStateBSON{
				Generation: 1, Action: string(deployment.DesiredActionRun),
				Target: targetToBSON(migration.Target), RequestedAt: now,
			},
			"observed":   observedStateBSON{Phase: string(deployment.DeploymentPhasePending)},
			"storage":    storageStateBSON{Phase: string(deployment.StoragePhaseUnprovisioned)},
			"reconcile":  reconcileStateBSON{DueAt: timePtr(now)},
			"migration":  migrationStateBSON{LegacyResourceName: migration.LegacyResourceName, MigratedAt: now},
			"updated_at": now,
		},
		"$unset": bson.M{"revision": "", "config_hash": "", "resource_name": ""},
	}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var raw deploymentStateBSON
	err = r.states.FindOneAndUpdate(ctx, filter, update, opts).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, deployment.ErrDeployStateConflict
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: migrate legacy state: %w", err)
	}
	return toDeployState(raw), nil
}

// MigrateV2 explicitly advances a version-2 desired/observed document to the
// retained-storage contract. Existing PVC references are never trusted as a
// bound stable claim without a later live Kubernetes UID verification.
func (r *DeploymentStateRepo) MigrateV2(ctx context.Context, migration deployment.V2StateMigration) (*deployment.DeployState, error) {
	uid, err := ownedDeployment(migration.UserID, migration.DeploymentID)
	if err != nil {
		return nil, err
	}
	filter := ownerDeploymentFilter(uid, migration.DeploymentID)
	filter["record_version"] = deployment.PreviousDeployStateRecordVersion

	var current deploymentStateBSON
	if err := r.states.FindOne(ctx, filter).Decode(&current); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, deployment.ErrDeployStateConflict
		}
		return nil, fmt.Errorf("deployment_state_repo: load v2 migration source: %w", err)
	}

	now := normalizedTime(migration.MigratedAt)
	storage := storageStateBSON{Phase: string(deployment.StoragePhaseUnprovisioned)}
	legacyPVCName := strings.TrimSpace(current.Observed.Resources.LegacyStatePVCName)
	if legacyPVCName != "" {
		plan, err := deployment.NewStoragePlan(
			migration.UserID,
			migration.DeploymentID,
			current.Desired.Target.Namespace,
		)
		if err != nil {
			return nil, err
		}
		storage = storageToBSON(deployment.StorageState{
			StoragePlan:        plan,
			Phase:              deployment.StoragePhaseMigrationRequired,
			LegacyPVCName:      legacyPVCName,
			LegacyPVCNamespace: strings.TrimSpace(current.Observed.Resources.Namespace),
			PlannedAt:          now,
		})
	}

	update := bson.M{
		"$set": bson.M{
			"record_version": deployment.DeployStateRecordVersion,
			"storage":        storage,
			"updated_at":     now,
		},
		"$unset": bson.M{"observed.resources.state_pvc_name": ""},
	}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var migrated deploymentStateBSON
	err = r.states.FindOneAndUpdate(ctx, filter, update, opts).Decode(&migrated)
	if err == mongo.ErrNoDocuments {
		return nil, deployment.ErrDeployStateConflict
	}
	if err != nil {
		return nil, fmt.Errorf("deployment_state_repo: migrate v2 state: %w", err)
	}
	return toDeployState(migrated), nil
}

func (r *DeploymentStateRepo) findOneAndUpdate(ctx context.Context, filter, update any, operation string) (*deployment.DeployState, bool, error) {
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var raw deploymentStateBSON
	err := r.states.FindOneAndUpdate(ctx, filter, update, opts).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, false, deployment.ErrDeployStateConflict
	}
	if err != nil {
		return nil, false, fmt.Errorf("deployment_state_repo: %s: %w", operation, err)
	}
	return toDeployState(raw), true, nil
}

func (r *DeploymentStateRepo) claimFilter(claim deployment.ClaimRef, now time.Time) (bson.M, time.Time, error) {
	uid, err := ownedDeployment(claim.UserID, claim.DeploymentID)
	if err != nil {
		return nil, time.Time{}, err
	}
	if claim.Generation <= 0 {
		return nil, time.Time{}, deployment.ErrDeployStateClaim
	}
	if err := deployment.ValidateClaimIdentity(claim.Owner, claim.Token); err != nil {
		return nil, time.Time{}, err
	}
	normalized := normalizedTime(now)
	filter := ownerDeploymentFilter(uid, claim.DeploymentID)
	filter["record_version"] = deployment.DeployStateRecordVersion
	filter["desired.generation"] = claim.Generation
	filter["reconcile.claim.generation"] = claim.Generation
	filter["reconcile.claim.token"] = claim.Token
	filter["reconcile.claim.owner"] = claim.Owner
	filter["reconcile.claim.lease_expires_at"] = bson.M{"$gt": normalized}
	return filter, normalized, nil
}

func (r *DeploymentStateRepo) claimMatches(ctx context.Context, filter bson.M) (bool, error) {
	var result struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := r.states.FindOne(ctx, filter, options.FindOne().SetProjection(bson.M{"_id": 1})).Decode(&result)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func validateRunStateInput(input deployment.RunStateInput) (bson.ObjectID, time.Time, error) {
	uid, err := ownedDeployment(input.UserID, input.DeploymentID)
	if err != nil {
		return bson.NilObjectID, time.Time{}, err
	}
	if input.ExpectedGeneration < 0 {
		return bson.NilObjectID, time.Time{}, deployment.ErrDeployStateConflict
	}
	if err := deployment.ValidateDeploymentTarget(input.Target); err != nil {
		return bson.NilObjectID, time.Time{}, err
	}
	return uid, normalizedTime(input.RequestedAt), nil
}

func ownedDeployment(userID, deploymentID string) (bson.ObjectID, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return bson.NilObjectID, fmt.Errorf("deployment_state_repo: invalid user_id: %w", err)
	}
	if strings.TrimSpace(deploymentID) == "" {
		return bson.NilObjectID, deployment.ErrDeployStateConflict
	}
	return uid, nil
}

func normalizedTime(value time.Time) time.Time {
	if value.IsZero() {
		value = time.Now()
	}
	return value.UTC().Truncate(time.Millisecond)
}

func replayGeneration(expected, current int64) bool {
	return expected == current || (current > 0 && expected == current-1)
}

func sameRunTarget(desired desiredStateBSON, target deployment.DeploymentTarget) bool {
	return desired.Action == string(deployment.DesiredActionRun) && desired.Target == targetToBSON(target)
}

func ownerDeploymentFilter(uid bson.ObjectID, deploymentID string) bson.M {
	return bson.M{"user_id": uid, "deployment_id": deploymentID}
}

func addTargetFilter(filter bson.M, target deployment.DeploymentTarget) {
	filter["desired.action"] = string(deployment.DesiredActionRun)
	filter["desired.target.revision"] = target.Revision
	filter["desired.target.config_hash"] = target.ConfigHash
	filter["desired.target.schema_version"] = target.SchemaVersion
	filter["desired.target.namespace"] = target.Namespace
	filter["desired.target.runtime_image"] = target.RuntimeImage
}

func storagePlanFilter(plan deployment.StoragePlan) bson.M {
	return bson.M{
		"storage.storage_id":               plan.StorageID,
		"storage.namespace":                plan.Namespace,
		"storage.pvc_name":                 plan.PVCName,
		"storage.requested_capacity_bytes": plan.RequestedCapacityBytes,
		"storage.access_mode":              string(plan.AccessMode),
		"storage.volume_mode":              string(plan.VolumeMode),
		"storage.storage_class_policy":     string(plan.StorageClassPolicy),
	}
}

func cloneFilter(source bson.M) bson.M {
	copy := make(bson.M, len(source)+1)
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func cloneMap(source bson.M) bson.M {
	copy := make(bson.M, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func targetToBSON(target deployment.DeploymentTarget) deploymentTargetBSON {
	return deploymentTargetBSON{
		Revision: target.Revision, ConfigHash: target.ConfigHash, SchemaVersion: target.SchemaVersion,
		Namespace: target.Namespace, RuntimeImage: target.RuntimeImage,
	}
}

func targetFromBSON(target deploymentTargetBSON) deployment.DeploymentTarget {
	return deployment.DeploymentTarget{
		Revision: target.Revision, ConfigHash: target.ConfigHash, SchemaVersion: target.SchemaVersion,
		Namespace: target.Namespace, RuntimeImage: target.RuntimeImage,
	}
}

func resourcesToBSON(resources deployment.ResourceRefs) resourceRefsBSON {
	return resourceRefsBSON{
		Namespace: resources.Namespace, DeploymentName: resources.DeploymentName, ServiceName: resources.ServiceName,
		DeliverySecretName: resources.DeliverySecretName, RuntimeSecretName: resources.RuntimeSecretName,
	}
}

func resourcesFromBSON(resources resourceRefsBSON) deployment.ResourceRefs {
	return deployment.ResourceRefs{
		Namespace: resources.Namespace, DeploymentName: resources.DeploymentName, ServiceName: resources.ServiceName,
		DeliverySecretName: resources.DeliverySecretName, RuntimeSecretName: resources.RuntimeSecretName,
	}
}

func storageToBSON(storage deployment.StorageState) storageStateBSON {
	return storageStateBSON{
		Phase: string(storage.Phase), StorageID: storage.StorageID, Namespace: storage.Namespace,
		PVCName: storage.PVCName, RequestedCapacityBytes: storage.RequestedCapacityBytes,
		AccessMode: string(storage.AccessMode), VolumeMode: string(storage.VolumeMode),
		StorageClassPolicy: string(storage.StorageClassPolicy), PVCUID: storage.PVCUID,
		StorageClassName: storage.StorageClassName, CapacityBytes: storage.CapacityBytes,
		LegacyPVCName: storage.LegacyPVCName, LegacyPVCNamespace: storage.LegacyPVCNamespace,
		PlannedAt:      storage.PlannedAt,
		LastObservedAt: storage.LastObservedAt,
	}
}

func storageFromBSON(storage storageStateBSON) deployment.StorageState {
	return deployment.StorageState{
		StoragePlan: deployment.StoragePlan{
			StorageID: storage.StorageID, Namespace: storage.Namespace, PVCName: storage.PVCName,
			RequestedCapacityBytes: storage.RequestedCapacityBytes,
			AccessMode:             deployment.StorageAccessMode(storage.AccessMode),
			VolumeMode:             deployment.StorageVolumeMode(storage.VolumeMode),
			StorageClassPolicy:     deployment.StorageClassPolicy(storage.StorageClassPolicy),
		},
		Phase: deployment.StoragePhase(storage.Phase), PVCUID: storage.PVCUID,
		StorageClassName: storage.StorageClassName, CapacityBytes: storage.CapacityBytes,
		LegacyPVCName: storage.LegacyPVCName, LegacyPVCNamespace: storage.LegacyPVCNamespace,
		PlannedAt:      storage.PlannedAt.UTC(),
		LastObservedAt: storage.LastObservedAt.UTC(),
	}
}

func toDeployState(raw deploymentStateBSON) *deployment.DeployState {
	state := &deployment.DeployState{
		RecordVersion: raw.RecordVersion,
		UserID:        raw.UserID.Hex(),
		DeploymentID:  raw.DeploymentID,
		Desired: deployment.DesiredState{
			Generation: raw.Desired.Generation, Action: deployment.DesiredAction(raw.Desired.Action),
			Target: targetFromBSON(raw.Desired.Target), RequestedAt: raw.Desired.RequestedAt.UTC(),
		},
		Observed: deployment.ObservedState{
			Generation: raw.Observed.Generation, Phase: deployment.DeploymentPhase(raw.Observed.Phase),
			Ready: raw.Observed.Ready, Endpoint: raw.Observed.Endpoint,
			Resources: resourcesFromBSON(raw.Observed.Resources), LastTransitionAt: raw.Observed.LastTransitionAt.UTC(),
		},
		Storage: storageFromBSON(raw.Storage),
		Reconcile: deployment.ReconcileState{
			DueAt: utcTimePtr(raw.Reconcile.DueAt), Attempt: raw.Reconcile.Attempt,
			ProcessedGeneration: raw.Reconcile.ProcessedGeneration,
		},
		CreatedAt: raw.CreatedAt.UTC(), UpdatedAt: raw.UpdatedAt.UTC(),
	}
	if raw.Observed.Target != nil {
		target := targetFromBSON(*raw.Observed.Target)
		state.Observed.Target = &target
	}
	if raw.Observed.LastError != nil {
		state.Observed.LastError = &deployment.DeploymentError{
			Code: raw.Observed.LastError.Code, Message: raw.Observed.LastError.Message,
			Retryable: raw.Observed.LastError.Retryable, Generation: raw.Observed.LastError.Generation,
			OccurredAt: raw.Observed.LastError.OccurredAt.UTC(),
		}
	}
	if raw.Reconcile.Claim != nil {
		state.Reconcile.Claim = &deployment.ReconcileClaim{
			Generation: raw.Reconcile.Claim.Generation, Token: raw.Reconcile.Claim.Token,
			Owner: raw.Reconcile.Claim.Owner, LeaseExpiresAt: raw.Reconcile.Claim.LeaseExpiresAt.UTC(),
		}
	}
	if raw.Migration != nil {
		state.Migration = &deployment.MigrationState{
			LegacyResourceName: raw.Migration.LegacyResourceName,
			MigratedAt:         raw.Migration.MigratedAt.UTC(),
		}
	}
	return state
}

func timePtr(value time.Time) *time.Time {
	return &value
}

func utcTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

var _ deployment.DeployStateStore = (*DeploymentStateRepo)(nil)
