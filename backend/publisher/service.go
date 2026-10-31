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
	"backend/mcp"
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

type revisionPageStore interface {
	ListPage(ctx context.Context, userID, deploymentID string, request deployment.RevisionPageRequest) (deployment.RevisionPage, error)
}

type MCPServerCatalog interface {
	GetEnabledByIDs(ctx context.Context, serverIDs []string) (map[string]mcp.CatalogEntry, error)
}

type Config struct {
	Agents           AgentReader
	Revisions        RevisionStore
	Platform         *agent.PlatformConfig
	Catalog          *tools.ToolRegistry
	MCPServers       MCPServerCatalog
	SnapshotAttempts int
}

type Service struct {
	agents           AgentReader
	revisions        RevisionStore
	platformXML      string
	catalog          *tools.ToolRegistry
	mcpServers       MCPServerCatalog
	snapshotAttempts int
}

type Result struct {
	Revision    *deployment.Revision
	WasExisting bool
}

func NewService(cfg Config) (*Service, error) {
	if cfg.Agents == nil || cfg.Revisions == nil || cfg.Catalog == nil || cfg.MCPServers == nil {
		return nil, fmt.Errorf("publisher: agents, revisions, tool catalog, and MCP catalog are required")
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
		catalog: cfg.Catalog, mcpServers: cfg.MCPServers, snapshotAttempts: attempts,
	}, nil
}

func (s *Service) Publish(ctx context.Context, userID, rootAgentID, idempotencyKey string) (*Result, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(rootAgentID) == "" {
		return nil, ErrRootAgentNotFound
	}
	if err := deployment.ValidateRevisionIdempotencyKey(idempotencyKey); err != nil {
		return nil, err
	}
	var frozen map[string]agentSnapshot
	bundleRootAgentID := rootAgentID
	stable := false
	// Publishing is an optimistic two-pass snapshot, not a locked transaction:
	// pass one walks and freezes the reachable graph; pass two reloads every
	// observed agent and compares its deployable projection. A mismatch retries
	// the whole operation, and no revision is written unless one pass converges.
	for attempt := 0; attempt < s.snapshotAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		root, err := s.agents.GetByID(ctx, rootAgentID, userID)
		if err != nil {
			return nil, ErrRootAgentNotFound
		}
		candidate := map[string]agentSnapshot(nil)
		candidateRootID := rootAgentID
		var teamProjection *teamDeploymentProjection
		if agent.EffectiveResourceKind(root) == agent.ResourceKindAgentTeam {
			if root.TeamGraph == nil {
				return nil, fmt.Errorf("%w: team has no graph", ErrInvalidGraph)
			}
			candidateRootID = root.TeamGraph.EntryAgentID
			candidate, err = s.walkTeamGraph(ctx, userID, root)
			projection := projectTeamGraph(root.TeamGraph)
			teamProjection = &projection
		} else {
			candidate, err = s.walkGraph(ctx, userID, root)
		}
		if err != nil {
			return nil, err
		}
		unchanged := false
		if teamProjection != nil {
			unchanged, err = s.teamSnapshotUnchanged(ctx, userID, rootAgentID, candidate, *teamProjection)
		} else {
			unchanged, err = s.snapshotUnchanged(ctx, userID, candidate)
		}
		if err != nil {
			return nil, err
		}
		if unchanged {
			frozen = candidate
			bundleRootAgentID = candidateRootID
			stable = true
			break
		}
	}
	if !stable {
		return nil, ErrGraphUnstable
	}

	ids := sortedAgentIDs(frozen)
	connections, err := s.resolveDeploymentConnections(ctx, frozen)
	if err != nil {
		return nil, err
	}
	agents := make([]deployment.BundleAgent, len(ids))
	for i, id := range ids {
		snapshot := frozen[id]
		converted, err := deployment.BundleAgentFromAgent(&snapshot.Agent, connections[id])
		if err != nil {
			return nil, fmt.Errorf("%w: agent %q: %v", ErrInvalidGraph, id, err)
		}
		agents[i] = converted
	}
	bundle := &deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion,
		DeploymentID:  rootAgentID,
		RootAgentID:   bundleRootAgentID,
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
		UserID: userID, DeploymentID: rootAgentID, RootAgentID: bundleRootAgentID,
		IdempotencyKey: idempotencyKey, ConfigHash: hash,
		SchemaVersion: deployment.SchemaVersion, BundleJSON: bundleJSON,
	})
	if err != nil {
		return nil, err
	}
	return &Result{Revision: revision, WasExisting: wasExisting}, nil
}

type teamDeploymentProjection struct {
	EntryAgentID string
	NodeIDs      []string
	Edges        []teamDeploymentEdgeProjection
}

// teamDeploymentEdgeProjection intentionally contains only behavior that is
// compiled into a deployment bundle. Canvas attachment ports belong to the
// Studio presentation and must not make an otherwise stable snapshot appear
// deployably different.
type teamDeploymentEdgeProjection struct {
	SourceAgentID string
	TargetAgentID string
	ToolName      string
	Description   string
	Instructions  string
}

func projectTeamGraph(graph *agent.TeamGraph) teamDeploymentProjection {
	projection := teamDeploymentProjection{EntryAgentID: graph.EntryAgentID}
	projection.NodeIDs = make([]string, len(graph.Nodes))
	for i, node := range graph.Nodes {
		projection.NodeIDs[i] = node.AgentID
	}
	sort.Strings(projection.NodeIDs)
	projection.Edges = make([]teamDeploymentEdgeProjection, len(graph.Edges))
	for i, edge := range graph.Edges {
		projection.Edges[i] = teamDeploymentEdgeProjection{
			SourceAgentID: edge.SourceAgentID,
			TargetAgentID: edge.TargetAgentID,
			ToolName:      edge.ToolName,
			Description:   edge.Description,
			Instructions:  edge.Instructions,
		}
	}
	sort.Slice(projection.Edges, func(i, j int) bool {
		left, right := projection.Edges[i], projection.Edges[j]
		if left.SourceAgentID != right.SourceAgentID {
			return left.SourceAgentID < right.SourceAgentID
		}
		if left.TargetAgentID != right.TargetAgentID {
			return left.TargetAgentID < right.TargetAgentID
		}
		return left.ToolName < right.ToolName
	})
	return projection
}

func (s *Service) walkTeamGraph(ctx context.Context, userID string, team *agent.Agent) (map[string]agentSnapshot, error) {
	if team == nil || team.TeamGraph == nil || team.TeamGraph.EntryAgentID == "" {
		return nil, fmt.Errorf("%w: team has no entry agent", ErrInvalidGraph)
	}
	frozen := make(map[string]agentSnapshot, len(team.TeamGraph.Nodes))
	for _, node := range team.TeamGraph.Nodes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		base, err := s.agents.GetByID(ctx, node.AgentID, userID)
		if err != nil {
			return nil, fmt.Errorf("%w: team agent %q not found or not owned", ErrInvalidGraph, node.AgentID)
		}
		effective, err := agent.EffectiveTeamAgent(team, base, node.AgentID)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidGraph, err)
		}
		snapshot, err := snapshotAgent(effective)
		if err != nil {
			return nil, fmt.Errorf("%w: agent %q: %v", ErrInvalidGraph, node.AgentID, err)
		}
		if _, exists := frozen[node.AgentID]; exists {
			return nil, fmt.Errorf("%w: duplicate team agent %q", ErrInvalidGraph, node.AgentID)
		}
		frozen[node.AgentID] = snapshot
	}
	if _, exists := frozen[team.TeamGraph.EntryAgentID]; !exists {
		return nil, fmt.Errorf("%w: entry agent %q is not a team node", ErrInvalidGraph, team.TeamGraph.EntryAgentID)
	}
	return frozen, nil
}

func (s *Service) teamSnapshotUnchanged(
	ctx context.Context,
	userID, teamID string,
	first map[string]agentSnapshot,
	graphProjection teamDeploymentProjection,
) (bool, error) {
	team, err := s.agents.GetByID(ctx, teamID, userID)
	if err != nil || agent.EffectiveResourceKind(team) != agent.ResourceKindAgentTeam || team.TeamGraph == nil {
		return false, nil
	}
	if !reflect.DeepEqual(projectTeamGraph(team.TeamGraph), graphProjection) {
		return false, nil
	}
	for _, id := range sortedAgentIDs(first) {
		base, err := s.agents.GetByID(ctx, id, userID)
		if err != nil {
			return false, nil
		}
		effective, err := agent.EffectiveTeamAgent(team, base, id)
		if err != nil {
			return false, nil
		}
		converted, err := snapshotAgent(effective)
		if err != nil || !reflect.DeepEqual(converted.Projection, first[id].Projection) ||
			!reflect.DeepEqual(converted.Agent.MCPServers, first[id].Agent.MCPServers) {
			return false, nil
		}
	}
	return true, nil
}

// Restore copies an immutable historical publication into a new, forward-only
// revision. It does not change or reactivate the historical revision itself.
func (s *Service) Restore(ctx context.Context, userID, deploymentID string, sourceRevision int, idempotencyKey string) (*Result, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(deploymentID) == "" || sourceRevision <= 0 {
		return nil, deployment.ErrRevisionNotFound
	}
	if err := deployment.ValidateRevisionIdempotencyKey(idempotencyKey); err != nil {
		return nil, err
	}

	source, err := s.revisions.Get(ctx, userID, deploymentID, sourceRevision)
	if err != nil {
		return nil, err
	}
	bundle, err := deployment.Parse(source.BundleJSON)
	if err != nil || source.UserID != userID || source.DeploymentID != deploymentID || source.Revision != sourceRevision ||
		bundle.DeploymentID != deploymentID || bundle.RootAgentID != source.RootAgentID ||
		bundle.SchemaVersion != source.SchemaVersion || bundle.ConfigHash != source.ConfigHash {
		return nil, fmt.Errorf("%w: source revision %d failed integrity validation", ErrInvalidBundle, sourceRevision)
	}

	revision, wasExisting, err := s.revisions.Append(ctx, deployment.RevisionInput{
		UserID:         userID,
		DeploymentID:   deploymentID,
		RootAgentID:    source.RootAgentID,
		IdempotencyKey: idempotencyKey,
		SourceRevision: sourceRevision,
		ConfigHash:     source.ConfigHash,
		SchemaVersion:  source.SchemaVersion,
		BundleJSON:     append([]byte(nil), source.BundleJSON...),
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

func (s *Service) ListRevisionPage(ctx context.Context, userID, deploymentID string, request deployment.RevisionPageRequest) (deployment.RevisionPage, error) {
	store, ok := s.revisions.(revisionPageStore)
	if !ok {
		if request.BeforeRevision > 0 {
			return deployment.RevisionPage{}, errors.New("publisher: revision pagination is unavailable")
		}
		items, err := s.revisions.List(ctx, userID, deploymentID, request.Limit)
		return deployment.RevisionPage{Items: items}, err
	}
	return store.ListPage(ctx, userID, deploymentID, request)
}

type agentSnapshot struct {
	Agent      agent.Agent
	Projection deployment.BundleAgent
}

func snapshotAgent(a *agent.Agent) (agentSnapshot, error) {
	projection, err := deployment.BundleAgentFromAgent(a, nil)
	if err != nil {
		return agentSnapshot{}, err
	}
	copy := *a
	copy.Tools = append([]string(nil), a.Tools...)
	copy.Delegates = append([]agent.DelegateConfig(nil), a.Delegates...)
	copy.MCPServers = append([]agent.MCPServerSelection(nil), a.MCPServers...)
	copy.MCPConnections = nil
	return agentSnapshot{Agent: copy, Projection: projection}, nil
}

func (s *Service) walkGraph(ctx context.Context, userID string, root *agent.Agent) (map[string]agentSnapshot, error) {
	const (
		visiting = 1
		done     = 2
	)
	state := make(map[string]uint8)
	frozen := make(map[string]agentSnapshot)
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
		a := root
		var err error
		if parentID != "" || root == nil || root.ID != agentID {
			a, err = s.agents.GetByID(ctx, agentID, userID)
		}
		if err != nil || a == nil {
			if parentID == "" {
				return ErrRootAgentNotFound
			}
			return fmt.Errorf("%w: delegate %q from agent %q not found or not owned", ErrInvalidGraph, agentID, parentID)
		}
		converted, err := snapshotAgent(a)
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
	if root == nil {
		return nil, ErrRootAgentNotFound
	}
	if err := visit(root.ID, ""); err != nil {
		return nil, err
	}
	return frozen, nil
}

func (s *Service) snapshotUnchanged(ctx context.Context, userID string, first map[string]agentSnapshot) (bool, error) {
	for _, id := range sortedAgentIDs(first) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		a, err := s.agents.GetByID(ctx, id, userID)
		if err != nil {
			return false, nil
		}
		converted, err := snapshotAgent(a)
		if err != nil || !reflect.DeepEqual(converted.Projection, first[id].Projection) ||
			!reflect.DeepEqual(converted.Agent.MCPServers, first[id].Agent.MCPServers) {
			return false, nil
		}
	}
	return true, nil
}

func (s *Service) resolveDeploymentConnections(ctx context.Context, snapshots map[string]agentSnapshot) (map[string][]agent.MCPServerConnection, error) {
	allIDs := make([]string, 0)
	seen := make(map[string]struct{})
	for _, id := range sortedAgentIDs(snapshots) {
		for _, selection := range snapshots[id].Agent.MCPServers {
			if _, exists := seen[selection.ServerID]; exists {
				continue
			}
			seen[selection.ServerID] = struct{}{}
			allIDs = append(allIDs, selection.ServerID)
		}
	}
	entries, err := s.mcpServers.GetEnabledByIDs(ctx, allIDs)
	if err != nil {
		return nil, fmt.Errorf("publisher: resolve MCP catalog: %w", err)
	}
	resolved := make(map[string][]agent.MCPServerConnection, len(snapshots))
	for _, id := range sortedAgentIDs(snapshots) {
		selections := snapshots[id].Agent.MCPServers
		connections := make([]agent.MCPServerConnection, len(selections))
		for i, selection := range selections {
			entry, exists := entries[selection.ServerID]
			if !exists {
				return nil, fmt.Errorf("%w: agent %q selects unknown or disabled MCP server %q", ErrInvalidGraph, id, selection.ServerID)
			}
			if entry.ServerID != selection.ServerID {
				return nil, fmt.Errorf("%w: MCP catalog returned mismatched server_id %q for %q", ErrInvalidGraph, entry.ServerID, selection.ServerID)
			}
			if err := mcp.ValidateCatalogIdentity(entry); err != nil {
				return nil, fmt.Errorf("%w: invalid MCP catalog entry %q: %v", ErrInvalidGraph, selection.ServerID, err)
			}
			if err := tools.ValidateManagedMCPServerURL(entry.DeploymentURL); err != nil {
				return nil, fmt.Errorf("%w: invalid deployment URL for MCP server %q: %v", ErrInvalidGraph, selection.ServerID, err)
			}
			connections[i] = agent.MCPServerConnection{
				ServerID: entry.ServerID, Alias: entry.Alias, URL: entry.DeploymentURL,
			}
		}
		resolved[id] = connections
	}
	return resolved, nil
}

func sortedAgentIDs(agents map[string]agentSnapshot) []string {
	ids := make([]string, 0, len(agents))
	for id := range agents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
