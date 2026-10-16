package migration

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"backend/deployment"
)

const migrationRuntimeImage = "registry.example/runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type fakeMigrator struct {
	legacy deployment.LegacyStateMigration
	v2     deployment.V2StateMigration
	source deployment.StateMigrationSource
	state  *deployment.DeployState
}

func (f *fakeMigrator) MigrateLegacy(_ context.Context, migration deployment.LegacyStateMigration) (*deployment.DeployState, error) {
	f.legacy = migration
	f.state = &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion, UserID: migration.UserID, DeploymentID: migration.DeploymentID,
		Desired: deployment.DesiredState{Generation: 1, Action: deployment.DesiredActionRun, Target: migration.Target},
		Storage: deployment.StorageState{Phase: deployment.StoragePhaseUnprovisioned}, Migration: &deployment.MigrationState{},
	}
	return f.state, nil
}

func (f *fakeMigrator) MigrateV2(_ context.Context, migration deployment.V2StateMigration) (*deployment.DeployState, error) {
	f.v2 = migration
	phase := deployment.StoragePhaseUnprovisioned
	storage := deployment.StorageState{Phase: phase}
	if f.source.LegacyPVCName != "" {
		storage.Phase = deployment.StoragePhaseMigrationRequired
		storage.LegacyPVCName = f.source.LegacyPVCName
		storage.LegacyPVCNamespace = f.source.LegacyPVCNamespace
	}
	f.state = &deployment.DeployState{RecordVersion: deployment.DeployStateRecordVersion, UserID: migration.UserID, DeploymentID: migration.DeploymentID, Storage: storage}
	return f.state, nil
}

func (f *fakeMigrator) InspectMigrationSource(context.Context, string, string) (*deployment.StateMigrationSource, error) {
	copy := f.source
	return &copy, nil
}

func (f *fakeMigrator) Get(context.Context, string, string) (*deployment.DeployState, error) {
	if f.state == nil {
		return nil, deployment.ErrDeployStateNotFound
	}
	copy := *f.state
	return &copy, nil
}

type fakeRevisionReader struct{ revision *deployment.Revision }

func (f fakeRevisionReader) Get(context.Context, string, string, int) (*deployment.Revision, error) {
	if f.revision == nil {
		return nil, deployment.ErrRevisionNotFound
	}
	return f.revision, nil
}

func migrationRevision(t *testing.T) *deployment.Revision {
	t.Helper()
	bundle := deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion, DeploymentID: "deployment", RootAgentID: "agent", PlatformXML: "<platform />",
		Agents: []deployment.BundleAgent{{ID: "agent", Name: "agent", Provider: "openai", Model: "model", SystemPrompt: "prompt", ModelContextLimit: 4096, ContextWindow: 4, ContextKeepRatio: .5, MaxSteps: 4, MaxTokens: 100, MaxRuns: 4}},
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
	return &deployment.Revision{UserID: "user", DeploymentID: "deployment", RootAgentID: "agent", Revision: 3, ConfigHash: hash, SchemaVersion: deployment.SchemaVersion, BundleJSON: raw}
}

func TestMigrateLegacyDerivesTargetFromVerifiedRevision(t *testing.T) {
	now := time.Date(2026, 10, 15, 1, 2, 3, 0, time.UTC)
	revision := migrationRevision(t)
	states := &fakeMigrator{source: deployment.StateMigrationSource{
		UserID: "user", DeploymentID: "deployment", LegacyRevision: 3,
		LegacyConfigHash: revision.ConfigHash, LegacyResourceName: "old-runtime",
	}}
	service, err := NewService(states, fakeRevisionReader{revision: revision}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.MigrateLegacy(context.Background(), LegacyRequest{
		UserID: "user", DeploymentID: "deployment", Revision: 3,
		Namespace: "agentflow-runtimes", RuntimeImage: migrationRuntimeImage, LegacyResourceName: "old-runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Desired.Target.ConfigHash != migrationRevision(t).ConfigHash || states.legacy.MigratedAt != now || states.legacy.LegacyResourceName != "old-runtime" {
		t.Fatalf("result/migration = %+v/%+v", result, states.legacy)
	}
}

func TestMigrateLegacyRejectsCorruptRevision(t *testing.T) {
	revision := migrationRevision(t)
	revision.BundleJSON = []byte(`{"corrupt":true}`)
	states := &fakeMigrator{source: deployment.StateMigrationSource{LegacyRevision: 3, LegacyConfigHash: revision.ConfigHash}}
	service, err := NewService(states, fakeRevisionReader{revision: revision}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.MigrateLegacy(context.Background(), LegacyRequest{
		UserID: "user", DeploymentID: "deployment", Revision: 3,
		Namespace: "agentflow-runtimes", RuntimeImage: migrationRuntimeImage,
	})
	if !errors.Is(err, ErrInvalidRequest) || states.legacy.UserID != "" {
		t.Fatalf("error/migration = %v/%+v", err, states.legacy)
	}
}

func TestMigrateV2IsExplicitAndScoped(t *testing.T) {
	now := time.Date(2026, 10, 15, 1, 2, 3, 0, time.UTC)
	states := &fakeMigrator{source: deployment.StateMigrationSource{
		RecordVersion: deployment.PreviousDeployStateRecordVersion,
		DesiredTarget: deployment.DeploymentTarget{
			Revision: 3, ConfigHash: strings.Repeat("a", 64), SchemaVersion: 1,
			Namespace: "agentflow-runtimes", RuntimeImage: migrationRuntimeImage,
		},
	}}
	service, err := NewService(states, fakeRevisionReader{}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.MigrateV2(context.Background(), "user", "deployment"); err != nil {
		t.Fatal(err)
	}
	if states.v2.UserID != "user" || states.v2.DeploymentID != "deployment" || states.v2.MigratedAt != now {
		t.Fatalf("migration = %+v", states.v2)
	}
	if _, err := service.MigrateV2(context.Background(), "", "deployment"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid scope error = %v", err)
	}
}

func TestMigrateLegacyRejectsInvalidPlatformTarget(t *testing.T) {
	revision := migrationRevision(t)
	service, err := NewService(&fakeMigrator{source: deployment.StateMigrationSource{LegacyRevision: 3, LegacyConfigHash: revision.ConfigHash}}, fakeRevisionReader{revision: revision}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.MigrateLegacy(context.Background(), LegacyRequest{
		UserID: "user", DeploymentID: "deployment", Revision: 3,
		Namespace: "agentflow-runtimes", RuntimeImage: strings.Replace(migrationRuntimeImage, "@sha256:", ":", 1),
	})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid target error = %v", err)
	}
}
