package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"backend/agent"
	"backend/deployment"
	"backend/tools"
)

const defaultSnapshotAttempts = 3

var (
	ErrRootAgentNotFound = errors.New("publisher: root agent not found")
	ErrInvalidGraph      = errors.New("publisher: invalid agent graph")
	ErrGraphUnstable     = errors.New("publisher: agent graph changed during publication")
	ErrInvalidBundle     = errors.New("publisher: invalid deployment bundle")
	ErrBundleTooLarge    = errors.New("publisher: deployment bundle exceeds 12 MiB")
)

type AgentReader interface {
	GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error)
}

type RevisionStore interface {
	Append(ctx context.Context, input deployment.RevisionInput) (*deployment.Revision, bool, error)
	Get(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error)
	List(ctx context.Context, userID, deploymentID string, limit int) ([]deployment.Revision, error)
}

type Config struct {
	Agents           AgentReader
	Revisions        RevisionStore
	Platform         *agent.PlatformConfig
	Catalog          *tools.ToolRegistry
	SnapshotAttempts int
}

type Service struct {
	agents           AgentReader
	revisions        RevisionStore
	platformXML      string
	catalog          *tools.ToolRegistry
	snapshotAttempts int
}

type Result struct {
	Revision    *deployment.Revision
	WasExisting bool
}

func NewService(cfg Config) (*Service, error) {
	if cfg.Agents == nil || cfg.Revisions == nil || cfg.Catalog == nil {
		return nil, fmt.Errorf("publisher: agents, revisions, and catalog are required")
	}
	if cfg.Platform == nil || strings.TrimSpace(cfg.Platform.Body) == "" {
		return nil, fmt.Errorf("publisher: platform XML is required")
	}
	attempts := cfg.SnapshotAttempts
	if attempts <= 0 {
		attempts = defaultSnapshotAttempts
	}
	return &Service{
		agents: cfg.Agents, revisions: cfg.Revisions, platformXML: cfg.Platform.Body,
		catalog: cfg.Catalog, snapshotAttempts: attempts,
	}, nil
}

func (s *Service) Publish(ctx context.Context, userID, rootAgentID string) (*Result, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(rootAgentID) == "" {
		return nil, ErrRootAgentNotFound
	}
	var frozen map[string]deployment.BundleAgent
	stable := false
	// Publishing is an optimistic two-pass snapshot, not a locked transaction:
	// pass one walks and freezes the reachable graph; pass two reloads every
	// observed agent and compares its deployable projection. A mismatch retries
	// the whole operation, and no revision is written unless one pass converges.
	for attempt := 0; attempt < s.snapshotAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		candidate, err := s.walkGraph(ctx, userID, rootAgentID)
		if err != nil {
			return nil, err
		}
		unchanged, err := s.snapshotUnchanged(ctx, userID, candidate)
		if err != nil {
			return nil, err
		}
		if unchanged {
			frozen = candidate
			stable = true
			break
		}
	}
	if !stable {
		return nil, ErrGraphUnstable
	}

	ids := sortedAgentIDs(frozen)
	agents := make([]deployment.BundleAgent, len(ids))
	for i, id := range ids {
		agents[i] = frozen[id]
	}
	bundle := &deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion,
		DeploymentID:  rootAgentID,
		RootAgentID:   rootAgentID,
		PlatformXML:   s.platformXML,
		Agents:        agents,
	}
	capabilities := agent.ToolCapabilities{AsyncJobs: true}
	if err := bundle.ValidateForPublication(s.catalog, capabilities); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}
	bundle.ConfigHash = hash
	bundleJSON, err := json.Marshal(bundle)
	if err != nil {
		return nil, fmt.Errorf("%w: marshal: %v", ErrInvalidBundle, err)
	}
	if len(bundleJSON) > deployment.MaxBundleBytes {
		return nil, ErrBundleTooLarge
	}
	parsed, err := deployment.Parse(bundleJSON)
	if err != nil || parsed.ConfigHash != hash {
		return nil, fmt.Errorf("%w: artifact round trip: %v", ErrInvalidBundle, err)
	}

	revision, wasExisting, err := s.revisions.Append(ctx, deployment.RevisionInput{
		UserID: userID, DeploymentID: rootAgentID, RootAgentID: rootAgentID,
		ConfigHash: hash, SchemaVersion: deployment.SchemaVersion, BundleJSON: bundleJSON,
	})
	if err != nil {
		return nil, err
	}
	return &Result{Revision: revision, WasExisting: wasExisting}, nil
}

func (s *Service) GetBundle(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error) {
	return s.revisions.Get(ctx, userID, deploymentID, revision)
}

func (s *Service) ListRevisions(ctx context.Context, userID, deploymentID string, limit int) ([]deployment.Revision, error) {
	return s.revisions.List(ctx, userID, deploymentID, limit)
}

func (s *Service) walkGraph(ctx context.Context, userID, rootAgentID string) (map[string]deployment.BundleAgent, error) {
	const (
		visiting = 1
		done     = 2
	)
	state := make(map[string]uint8)
	frozen := make(map[string]deployment.BundleAgent)
	stack := make([]string, 0)
	var visit func(string, string) error
	visit = func(agentID, parentID string) error {
		if state[agentID] == done {
			return nil
		}
		if state[agentID] == visiting {
			cycle := append(append([]string(nil), stack...), agentID)
			return fmt.Errorf("%w: delegation cycle %s", ErrInvalidGraph, strings.Join(cycle, " -> "))
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		state[agentID] = visiting
		stack = append(stack, agentID)
		a, err := s.agents.GetByID(ctx, agentID, userID)
		if err != nil {
			if parentID == "" {
				return ErrRootAgentNotFound
			}
			return fmt.Errorf("%w: delegate %q from agent %q not found or not owned", ErrInvalidGraph, agentID, parentID)
		}
		converted, err := deployment.BundleAgentFromAgent(a)
		if err != nil {
			return fmt.Errorf("%w: agent %q: %v", ErrInvalidGraph, agentID, err)
		}
		frozen[agentID] = converted
		for _, delegate := range a.Delegates {
			if err := visit(delegate.AgentID, agentID); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		state[agentID] = done
		return nil
	}
	if err := visit(rootAgentID, ""); err != nil {
		return nil, err
	}
	return frozen, nil
}

func (s *Service) snapshotUnchanged(ctx context.Context, userID string, first map[string]deployment.BundleAgent) (bool, error) {
	for _, id := range sortedAgentIDs(first) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		a, err := s.agents.GetByID(ctx, id, userID)
		if err != nil {
			return false, nil
		}
		converted, err := deployment.BundleAgentFromAgent(a)
		if err != nil || !reflect.DeepEqual(converted, first[id]) {
			return false, nil
		}
	}
	return true, nil
}

func sortedAgentIDs(agents map[string]deployment.BundleAgent) []string {
	ids := make([]string, 0, len(agents))
	for id := range agents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
