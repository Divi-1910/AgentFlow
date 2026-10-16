// Package migration contains explicit, operator-invoked deployment-state
// migrations. It is intentionally not called during normal API startup.
package migration

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"backend/deployment"
)

var ErrInvalidRequest = errors.New("deployment migration request is invalid")

type StateMigrator interface {
	MigrateLegacy(context.Context, deployment.LegacyStateMigration) (*deployment.DeployState, error)
	MigrateV2(context.Context, deployment.V2StateMigration) (*deployment.DeployState, error)
	InspectMigrationSource(context.Context, string, string) (*deployment.StateMigrationSource, error)
	Get(context.Context, string, string) (*deployment.DeployState, error)
}

type RevisionReader interface {
	Get(context.Context, string, string, int) (*deployment.Revision, error)
}

type Service struct {
	states    StateMigrator
	revisions RevisionReader
	now       func() time.Time
}

func NewService(states StateMigrator, revisions RevisionReader, now func() time.Time) (*Service, error) {
	if states == nil || revisions == nil {
		return nil, fmt.Errorf("deployment migration: state and revision stores are required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{states: states, revisions: revisions, now: now}, nil
}

type LegacyRequest struct {
	UserID             string
	DeploymentID       string
	Revision           int
	Namespace          string
	RuntimeImage       string
	LegacyResourceName string
}

type Plan struct {
	Kind                     string                      `json:"kind"`
	UserID                   string                      `json:"user_id"`
	DeploymentID             string                      `json:"deployment_id"`
	FromRecordVersion        int                         `json:"from_record_version"`
	ToRecordVersion          int                         `json:"to_record_version"`
	Target                   deployment.DeploymentTarget `json:"target"`
	LegacyResourceName       string                      `json:"legacy_resource_name,omitempty"`
	LegacyPVCName            string                      `json:"legacy_pvc_name,omitempty"`
	LegacyPVCNamespace       string                      `json:"legacy_pvc_namespace,omitempty"`
	ResultingStoragePhase    deployment.StoragePhase     `json:"resulting_storage_phase"`
	RequiresStorageMigration bool                        `json:"requires_storage_migration"`
}

// MigrateLegacy derives immutable target metadata from the owned publication;
// operators do not type hashes or schema versions by hand.
func (s *Service) MigrateLegacy(ctx context.Context, request LegacyRequest) (*deployment.DeployState, error) {
	plan, err := s.PlanLegacy(ctx, request)
	if err != nil {
		return nil, err
	}
	state, err := s.states.MigrateLegacy(ctx, deployment.LegacyStateMigration{
		UserID: request.UserID, DeploymentID: request.DeploymentID, Target: plan.Target,
		LegacyResourceName: plan.LegacyResourceName, MigratedAt: s.now(),
	})
	if err != nil {
		return nil, err
	}
	if err := s.verify(ctx, plan); err != nil {
		return nil, err
	}
	return state, nil
}

func (s *Service) PlanLegacy(ctx context.Context, request LegacyRequest) (Plan, error) {
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.DeploymentID) == "" || request.Revision <= 0 {
		return Plan{}, ErrInvalidRequest
	}
	revision, err := s.revisions.Get(ctx, request.UserID, request.DeploymentID, request.Revision)
	if err != nil {
		return Plan{}, err
	}
	if revision == nil || revision.UserID != request.UserID || revision.DeploymentID != request.DeploymentID || revision.Revision != request.Revision {
		return Plan{}, ErrInvalidRequest
	}
	bundle, err := deployment.Parse(revision.BundleJSON)
	if err != nil || bundle.DeploymentID != request.DeploymentID || bundle.ConfigHash != revision.ConfigHash ||
		bundle.SchemaVersion != revision.SchemaVersion {
		return Plan{}, fmt.Errorf("%w: publication failed integrity validation", ErrInvalidRequest)
	}
	target := deployment.DeploymentTarget{
		Revision: revision.Revision, ConfigHash: revision.ConfigHash, SchemaVersion: revision.SchemaVersion,
		Namespace: request.Namespace, RuntimeImage: request.RuntimeImage,
	}
	if err := deployment.ValidateDeploymentTarget(target); err != nil {
		return Plan{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	source, err := s.states.InspectMigrationSource(ctx, request.UserID, request.DeploymentID)
	if err != nil {
		return Plan{}, err
	}
	legacyResourceName := strings.TrimSpace(request.LegacyResourceName)
	if source.RecordVersion != 0 || source.LegacyRevision != revision.Revision || source.LegacyConfigHash != revision.ConfigHash ||
		(legacyResourceName != "" && source.LegacyResourceName != legacyResourceName) {
		return Plan{}, deployment.ErrDeployStateConflict
	}
	return Plan{
		Kind: "legacy", UserID: request.UserID, DeploymentID: request.DeploymentID,
		FromRecordVersion: source.RecordVersion, ToRecordVersion: deployment.DeployStateRecordVersion,
		Target: target, LegacyResourceName: legacyResourceName,
		ResultingStoragePhase: deployment.StoragePhaseUnprovisioned,
	}, nil
}

func (s *Service) MigrateV2(ctx context.Context, userID, deploymentID string) (*deployment.DeployState, error) {
	plan, err := s.PlanV2(ctx, userID, deploymentID)
	if err != nil {
		return nil, err
	}
	state, err := s.states.MigrateV2(ctx, deployment.V2StateMigration{
		UserID: userID, DeploymentID: deploymentID, MigratedAt: s.now(),
	})
	if err != nil {
		return nil, err
	}
	if err := s.verify(ctx, plan); err != nil {
		return nil, err
	}
	return state, nil
}

func (s *Service) PlanV2(ctx context.Context, userID, deploymentID string) (Plan, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(deploymentID) == "" {
		return Plan{}, ErrInvalidRequest
	}
	source, err := s.states.InspectMigrationSource(ctx, userID, deploymentID)
	if err != nil {
		return Plan{}, err
	}
	if source.RecordVersion != deployment.PreviousDeployStateRecordVersion {
		return Plan{}, deployment.ErrDeployStateConflict
	}
	if err := deployment.ValidateDeploymentTarget(source.DesiredTarget); err != nil {
		return Plan{}, fmt.Errorf("%w: invalid v2 desired target: %v", ErrInvalidRequest, err)
	}
	phase := deployment.StoragePhaseUnprovisioned
	requiresStorageMigration := strings.TrimSpace(source.LegacyPVCName) != ""
	if requiresStorageMigration {
		phase = deployment.StoragePhaseMigrationRequired
	}
	return Plan{
		Kind: "v2", UserID: userID, DeploymentID: deploymentID,
		FromRecordVersion: source.RecordVersion, ToRecordVersion: deployment.DeployStateRecordVersion,
		Target: source.DesiredTarget, LegacyPVCName: strings.TrimSpace(source.LegacyPVCName),
		LegacyPVCNamespace:    strings.TrimSpace(source.LegacyPVCNamespace),
		ResultingStoragePhase: phase, RequiresStorageMigration: requiresStorageMigration,
	}, nil
}

func (s *Service) verify(ctx context.Context, plan Plan) error {
	state, err := s.states.Get(ctx, plan.UserID, plan.DeploymentID)
	if err != nil {
		return fmt.Errorf("deployment migration: post-migration read: %w", err)
	}
	if state == nil || state.RecordVersion != plan.ToRecordVersion || state.UserID != plan.UserID ||
		state.DeploymentID != plan.DeploymentID || state.Storage.Phase != plan.ResultingStoragePhase {
		return errors.New("deployment migration: post-migration verification failed")
	}
	if plan.Kind == "legacy" && (state.Desired.Target != plan.Target || state.Desired.Generation != 1 ||
		state.Desired.Action != deployment.DesiredActionRun || state.Migration == nil) {
		return errors.New("deployment migration: post-migration legacy target verification failed")
	}
	if plan.Kind == "v2" && plan.RequiresStorageMigration &&
		(state.Storage.LegacyPVCName != plan.LegacyPVCName || state.Storage.LegacyPVCNamespace != plan.LegacyPVCNamespace) {
		return errors.New("deployment migration: post-migration storage evidence verification failed")
	}
	return nil
}
