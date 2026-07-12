package deployment

import (
	"context"
	"fmt"
)

type DeployStateInput struct {
	UserID       string
	DeploymentID string
	Revision     int
	ConfigHash   string
	ResourceName string
}

type DeployStateStore interface {
	Select(ctx context.Context, input DeployStateInput) (*DeployState, error)
	Get(ctx context.Context, userID, deploymentID string) (*DeployState, error)
}

type RevisionReader interface {
	Get(ctx context.Context, userID, deploymentID string, revision int) (*Revision, error)
}

type SelectedRevision struct {
	State    DeployState
	Revision Revision
}

type RuntimeInputs struct {
	DeploymentID  string
	RootAgentID   string
	Revision      int
	ConfigHash    string
	SchemaVersion int
	ResourceName  string
	BundleJSON    []byte
}

type Service struct {
	states    DeployStateStore
	revisions RevisionReader
}

func NewService(states DeployStateStore, revisions RevisionReader) (*Service, error) {
	if states == nil || revisions == nil {
		return nil, fmt.Errorf("deployment: state and revision stores are required")
	}
	return &Service{states: states, revisions: revisions}, nil
}

func (s *Service) SelectRevision(ctx context.Context, userID, deploymentID string, revision int) (*SelectedRevision, error) {
	published, err := s.revisions.Get(ctx, userID, deploymentID, revision)
	if err != nil {
		return nil, err
	}
	if published == nil || published.UserID != userID || published.DeploymentID != deploymentID || published.Revision != revision {
		return nil, ErrDeployStateConflict
	}
	resourceName, err := ResourceName(deploymentID, revision, published.ConfigHash)
	if err != nil {
		return nil, err
	}
	state, err := s.states.Select(ctx, DeployStateInput{
		UserID: userID, DeploymentID: deploymentID, Revision: revision,
		ConfigHash: published.ConfigHash, ResourceName: resourceName,
	})
	if err != nil {
		return nil, err
	}
	return selectedRevision(state, published)
}

func (s *Service) GetSelectedRevision(ctx context.Context, userID, deploymentID string) (*SelectedRevision, error) {
	state, err := s.states.Get(ctx, userID, deploymentID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, ErrDeployStateConflict
	}
	published, err := s.revisions.Get(ctx, userID, deploymentID, state.Revision)
	if err != nil {
		return nil, err
	}
	return selectedRevision(state, published)
}

func (s *Service) BuildRuntimeInputs(ctx context.Context, userID, deploymentID string) (*RuntimeInputs, error) {
	selected, err := s.GetSelectedRevision(ctx, userID, deploymentID)
	if err != nil {
		return nil, err
	}
	bundle, err := Parse(selected.Revision.BundleJSON)
	if err != nil {
		return nil, fmt.Errorf("deployment: selected bundle is invalid: %w", err)
	}
	if bundle.DeploymentID != selected.State.DeploymentID || bundle.RootAgentID != selected.Revision.RootAgentID ||
		bundle.ConfigHash != selected.State.ConfigHash || bundle.SchemaVersion != selected.Revision.SchemaVersion {
		return nil, ErrDeployStateConflict
	}
	return &RuntimeInputs{
		DeploymentID: selected.State.DeploymentID, RootAgentID: selected.Revision.RootAgentID,
		Revision: selected.State.Revision, ConfigHash: selected.State.ConfigHash,
		SchemaVersion: selected.Revision.SchemaVersion, ResourceName: selected.State.ResourceName,
		BundleJSON: append([]byte(nil), selected.Revision.BundleJSON...),
	}, nil
}

func selectedRevision(state *DeployState, published *Revision) (*SelectedRevision, error) {
	if state == nil || published == nil || state.UserID != published.UserID ||
		state.DeploymentID != published.DeploymentID || state.Revision != published.Revision ||
		state.ConfigHash != published.ConfigHash {
		return nil, ErrDeployStateConflict
	}
	wantName, err := ResourceName(state.DeploymentID, state.Revision, state.ConfigHash)
	if err != nil || state.ResourceName != wantName {
		return nil, ErrDeployStateConflict
	}
	stateCopy := *state
	revisionCopy := *published
	revisionCopy.BundleJSON = append([]byte(nil), published.BundleJSON...)
	return &SelectedRevision{State: stateCopy, Revision: revisionCopy}, nil
}
