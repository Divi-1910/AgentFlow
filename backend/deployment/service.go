package deployment

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

type RunStateInput struct {
	UserID             string
	DeploymentID       string
	ExpectedGeneration int64
	Target             DeploymentTarget
	RequestedAt        time.Time
}

type DeleteStateInput struct {
	UserID             string
	DeploymentID       string
	ExpectedGeneration int64
	RequestedAt        time.Time
}

// DeployStateStore is defined by the application service that consumes it.
// The MongoDB adapter owns additional reconciliation methods, but those do not
// belong in this user-intent interface.
type DeployStateStore interface {
	RequestRun(ctx context.Context, input RunStateInput) (*DeployState, bool, error)
	RequestDelete(ctx context.Context, input DeleteStateInput) (*DeployState, bool, error)
	Get(ctx context.Context, userID, deploymentID string) (*DeployState, error)
}

type RevisionReader interface {
	Get(ctx context.Context, userID, deploymentID string, revision int) (*Revision, error)
	List(ctx context.Context, userID, deploymentID string, limit int) ([]Revision, error)
}

// RunRequest is an internal application command. Namespace and RuntimeImage
// must come from trusted platform policy when an HTTP handler is added; they
// must not be copied directly from user-controlled JSON.
type RunRequest struct {
	UserID             string
	DeploymentID       string
	Revision           int
	ExpectedGeneration int64
	Namespace          string
	RuntimeImage       string
}

type DeleteRequest struct {
	UserID             string
	DeploymentID       string
	ExpectedGeneration int64
}

type MutationResult struct {
	State   DeployState
	Changed bool
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

func (s *Service) RequestRun(ctx context.Context, request RunRequest) (*MutationResult, error) {
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.DeploymentID) == "" ||
		request.Revision <= 0 || request.ExpectedGeneration < 0 {
		return nil, fmt.Errorf("%w: owner, deployment, positive revision, and nonnegative expected generation are required", ErrDeployStateConflict)
	}

	published, err := s.revisions.Get(ctx, request.UserID, request.DeploymentID, request.Revision)
	if err != nil {
		return nil, err
	}
	if published == nil || published.UserID != request.UserID || published.DeploymentID != request.DeploymentID ||
		published.Revision != request.Revision {
		return nil, ErrDeployStateConflict
	}

	target := DeploymentTarget{
		Revision:      published.Revision,
		ConfigHash:    published.ConfigHash,
		SchemaVersion: published.SchemaVersion,
		Namespace:     request.Namespace,
		RuntimeImage:  request.RuntimeImage,
	}
	if err := ValidateDeploymentTarget(target); err != nil {
		return nil, err
	}

	// Resolve an exact retry before checking newest publication. A later
	// publication must not turn the network retry of an already-applied desired
	// state into a false rollback error.
	current, err := s.states.Get(ctx, request.UserID, request.DeploymentID)
	if err == nil {
		if current.Storage.Phase != "" && current.Storage.Phase != StoragePhaseUnprovisioned &&
			current.Storage.Namespace != target.Namespace {
			return nil, fmt.Errorf(
				"%w: namespace %q differs from retained storage namespace %q",
				ErrDeployStorageConflict,
				target.Namespace,
				current.Storage.Namespace,
			)
		}
		if current.Desired.Action == DesiredActionRun && current.Desired.Target == target &&
			current.Desired.Generation > 0 && request.ExpectedGeneration == current.Desired.Generation-1 {
			return mutationResult(current, false)
		}
	}
	if err != nil && !errors.Is(err, ErrDeployStateNotFound) {
		return nil, err
	}

	latest, err := s.revisions.List(ctx, request.UserID, request.DeploymentID, 1)
	if err != nil {
		return nil, err
	}
	if len(latest) != 1 || latest[0].Revision != request.Revision {
		return nil, ErrDeployStateRollback
	}

	state, changed, err := s.states.RequestRun(ctx, RunStateInput{
		UserID:             request.UserID,
		DeploymentID:       request.DeploymentID,
		ExpectedGeneration: request.ExpectedGeneration,
		Target:             target,
		RequestedAt:        time.Now().UTC(),
	})
	if err != nil {
		return nil, err
	}
	return mutationResult(state, changed)
}

func (s *Service) RequestDelete(ctx context.Context, request DeleteRequest) (*MutationResult, error) {
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.DeploymentID) == "" || request.ExpectedGeneration <= 0 {
		return nil, fmt.Errorf("%w: owner, deployment, and positive expected generation are required", ErrDeployStateConflict)
	}
	state, changed, err := s.states.RequestDelete(ctx, DeleteStateInput{
		UserID:             request.UserID,
		DeploymentID:       request.DeploymentID,
		ExpectedGeneration: request.ExpectedGeneration,
		RequestedAt:        time.Now().UTC(),
	})
	if err != nil {
		return nil, err
	}
	return mutationResult(state, changed)
}

func (s *Service) Get(ctx context.Context, userID, deploymentID string) (*DeployState, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(deploymentID) == "" {
		return nil, fmt.Errorf("%w: owner and deployment are required", ErrDeployStateConflict)
	}
	return s.states.Get(ctx, userID, deploymentID)
}

func mutationResult(state *DeployState, changed bool) (*MutationResult, error) {
	if state == nil {
		return nil, ErrDeployStateConflict
	}
	copy := cloneDeployState(state)
	return &MutationResult{State: copy, Changed: changed}, nil
}

func cloneDeployState(state *DeployState) DeployState {
	copy := *state
	if state.Observed.Target != nil {
		target := *state.Observed.Target
		copy.Observed.Target = &target
	}
	if state.Observed.LastError != nil {
		lastError := *state.Observed.LastError
		copy.Observed.LastError = &lastError
	}
	if state.Reconcile.DueAt != nil {
		dueAt := *state.Reconcile.DueAt
		copy.Reconcile.DueAt = &dueAt
	}
	if state.Reconcile.Claim != nil {
		claim := *state.Reconcile.Claim
		copy.Reconcile.Claim = &claim
	}
	if state.Migration != nil {
		migration := *state.Migration
		copy.Migration = &migration
	}
	return copy
}
