package handlers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"backend/agent"
	"backend/tools"
)

const (
	maxTeamNodes        = 50
	maxTeamEdges        = 100
	maxTeamPathDepth    = agent.DefaultMaxDelegationDepth
	maxCanvasCoordinate = 1_000_000
)

type AgentTeamHandler struct {
	agentRepo    agentStore
	validator    *agentConfigurationValidator
	dependencies resourceDependencyChecker
}

func NewAgentTeamHandler(
	agentRepo agentStore,
	toolRegistry *tools.ToolRegistry,
	toolCatalog toolDefinitionCatalog,
	mcpCatalog mcpServerLookup,
	modelCatalog llmModelLookup,
	providers providerAvailability,
	dependencies ...resourceDependencyChecker,
) *AgentTeamHandler {
	handler := &AgentTeamHandler{
		agentRepo: agentRepo,
		validator: &agentConfigurationValidator{
			agentRepo: agentRepo, toolRegistry: toolRegistry, toolCatalog: toolCatalog, mcpCatalog: mcpCatalog,
			modelCatalog: modelCatalog, providers: providers,
		},
	}
	if len(dependencies) > 0 {
		handler.dependencies = dependencies[0]
	}
	return handler
}

type AgentTeamPositionJSON struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type AgentTeamNodeJSON struct {
	AgentID  string                `json:"agent_id"`
	Position AgentTeamPositionJSON `json:"position"`
}

type AgentTeamEdgeJSON struct {
	SourceAgentID string `json:"source_agent_id"`
	TargetAgentID string `json:"target_agent_id"`
	SourcePort    string `json:"source_port,omitempty"`
	TargetPort    string `json:"target_port,omitempty"`
	ToolName      string `json:"tool_name"`
	Description   string `json:"description"`
	Instructions  string `json:"instructions,omitempty"`
}

type CreateAgentTeamRequest struct {
	Name         string              `json:"name"`
	Description  string              `json:"description"`
	EntryAgentID string              `json:"entry_agent_id"`
	Nodes        []AgentTeamNodeJSON `json:"nodes"`
	Edges        []AgentTeamEdgeJSON `json:"edges"`
}

type UpdateAgentTeamRequest struct {
	Name         *string              `json:"name"`
	Description  *string              `json:"description"`
	EntryAgentID *string              `json:"entry_agent_id"`
	Nodes        *[]AgentTeamNodeJSON `json:"nodes"`
	Edges        *[]AgentTeamEdgeJSON `json:"edges"`
}

type AgentTeamResponse struct {
	ID           string              `json:"id"`
	Kind         string              `json:"kind"`
	Name         string              `json:"name"`
	Description  string              `json:"description,omitempty"`
	EntryAgentID string              `json:"entry_agent_id"`
	Nodes        []AgentTeamNodeJSON `json:"nodes"`
	Edges        []AgentTeamEdgeJSON `json:"edges"`
	CreatedAt    string              `json:"created_at"`
	UpdatedAt    string              `json:"updated_at"`
}

func toAgentTeamResponse(a *agent.Agent) AgentTeamResponse {
	graph := a.TeamGraph
	if graph == nil {
		graph = &agent.TeamGraph{}
	}
	nodes := make([]AgentTeamNodeJSON, len(graph.Nodes))
	for i, node := range graph.Nodes {
		nodes[i] = AgentTeamNodeJSON{
			AgentID:  node.AgentID,
			Position: AgentTeamPositionJSON{X: node.Position.X, Y: node.Position.Y},
		}
	}
	edges := make([]AgentTeamEdgeJSON, len(graph.Edges))
	for i, edge := range graph.Edges {
		sourcePort, targetPort := effectiveTeamEdgePorts(edge.SourcePort, edge.TargetPort)
		edges[i] = AgentTeamEdgeJSON{
			SourceAgentID: edge.SourceAgentID,
			TargetAgentID: edge.TargetAgentID,
			SourcePort:    sourcePort,
			TargetPort:    targetPort,
			ToolName:      edge.ToolName,
			Description:   edge.Description,
			Instructions:  edge.Instructions,
		}
	}
	return AgentTeamResponse{
		ID: a.ID, Kind: string(agent.ResourceKindAgentTeam), Name: a.Name, Description: a.Description,
		EntryAgentID: graph.EntryAgentID, Nodes: nodes, Edges: edges,
		CreatedAt: a.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt: a.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (h *AgentTeamHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req CreateAgentTeamRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := validateNonBlank("name", req.Name); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	graph := teamGraphFromJSON(req.EntryAgentID, req.Nodes, req.Edges)
	if err := h.validateTeamGraph(r.Context(), userID, graph); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	created, err := h.agentRepo.Create(r.Context(), userID, &agent.Agent{
		Kind: agent.ResourceKindAgentTeam, Name: strings.TrimSpace(req.Name),
		Description: req.Description, TeamGraph: graph,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create agent team")
		return
	}
	writeJSON(w, http.StatusCreated, toAgentTeamResponse(created))
}

func (h *AgentTeamHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	all, err := h.agentRepo.ListByUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent teams")
		return
	}
	response := make([]AgentTeamResponse, 0, len(all))
	for _, candidate := range all {
		if agent.EffectiveResourceKind(candidate) == agent.ResourceKindAgentTeam {
			response = append(response, toAgentTeamResponse(candidate))
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *AgentTeamHandler) Get(w http.ResponseWriter, r *http.Request) {
	team, ok := h.loadOwnedTeam(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, toAgentTeamResponse(team))
}

func (h *AgentTeamHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req UpdateAgentTeamRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	teamID := r.PathValue("id")
	current, err := h.agentRepo.GetByID(r.Context(), teamID, userID)
	if err != nil || agent.EffectiveResourceKind(current) != agent.ResourceKindAgentTeam {
		if err != nil && err.Error() != "agent not found" {
			writeError(w, http.StatusInternalServerError, "failed to load agent team")
			return
		}
		writeError(w, http.StatusNotFound, "agent team not found")
		return
	}
	if err := validateOptionalNonBlank("name", req.Name); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	graph := cloneTeamGraph(current.TeamGraph)
	graphChanged := req.EntryAgentID != nil || req.Nodes != nil || req.Edges != nil
	if current.TeamGraph == nil && !graphChanged {
		writeError(w, http.StatusBadRequest, "legacy agent team must be recreated with entry_agent_id, nodes, and edges")
		return
	}
	if graphChanged {
		if graph == nil {
			graph = &agent.TeamGraph{}
		}
		if req.EntryAgentID != nil {
			graph.EntryAgentID = strings.TrimSpace(*req.EntryAgentID)
		}
		if req.Nodes != nil {
			graph.Nodes = teamNodesFromJSON(*req.Nodes)
		}
		if req.Edges != nil {
			graph.Edges = teamEdgesFromJSON(*req.Edges)
		}
		if err := h.validateTeamGraph(r.Context(), userID, graph); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	input := agent.UpdateAgentInput{Name: trimmedStringPointer(req.Name), Description: req.Description}
	if graphChanged {
		input.TeamGraph = graph
	}
	updated, err := h.agentRepo.Update(r.Context(), teamID, userID, input)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent team not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update agent team")
		return
	}
	writeJSON(w, http.StatusOK, toAgentTeamResponse(updated))
}

func (h *AgentTeamHandler) Delete(w http.ResponseWriter, r *http.Request) {
	team, ok := h.loadOwnedTeam(w, r)
	if !ok {
		return
	}
	userID, _ := getUserID(r)
	if h.dependencies != nil {
		dependencies, err := h.dependencies.BlockingDependencies(r.Context(), userID, team.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to verify resource dependencies")
			return
		}
		if len(dependencies) > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "resource cannot be deleted while it has dependencies", "dependencies": dependencies,
			})
			return
		}
	}
	if err := h.agentRepo.Delete(r.Context(), team.ID, userID); err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent team not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete agent team")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "agent team deleted"})
}

func (h *AgentTeamHandler) loadOwnedTeam(w http.ResponseWriter, r *http.Request) (*agent.Agent, bool) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	team, err := h.agentRepo.GetByID(r.Context(), r.PathValue("id"), userID)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent team not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load agent team")
		}
		return nil, false
	}
	if agent.EffectiveResourceKind(team) != agent.ResourceKindAgentTeam {
		writeError(w, http.StatusNotFound, "agent team not found")
		return nil, false
	}
	return team, true
}

func (h *AgentTeamHandler) validateTeamGraph(ctx context.Context, userID string, graph *agent.TeamGraph) error {
	if graph == nil {
		return errors.New("team graph is required")
	}
	if strings.TrimSpace(graph.EntryAgentID) == "" {
		return errors.New("entry_agent_id is required")
	}
	if len(graph.Nodes) == 0 {
		return errors.New("nodes must contain the entry agent")
	}
	if len(graph.Nodes) > maxTeamNodes {
		return fmt.Errorf("nodes cannot contain more than %d agents", maxTeamNodes)
	}
	if len(graph.Edges) > maxTeamEdges {
		return fmt.Errorf("edges cannot contain more than %d delegations", maxTeamEdges)
	}

	agentsByID := make(map[string]*agent.Agent, len(graph.Nodes))
	for i := range graph.Nodes {
		node := &graph.Nodes[i]
		node.AgentID = strings.TrimSpace(node.AgentID)
		if node.AgentID == "" {
			return fmt.Errorf("nodes[%d].agent_id is required", i)
		}
		if _, exists := agentsByID[node.AgentID]; exists {
			return fmt.Errorf("duplicate node agent_id %q", node.AgentID)
		}
		if !validCanvasCoordinate(node.Position.X) || !validCanvasCoordinate(node.Position.Y) {
			return fmt.Errorf("nodes[%d].position must contain finite coordinates between -%d and %d", i, maxCanvasCoordinate, maxCanvasCoordinate)
		}
		member, err := h.agentRepo.GetByID(ctx, node.AgentID, userID)
		if err != nil {
			return fmt.Errorf("node agent %s not found or not owned", node.AgentID)
		}
		if agent.EffectiveResourceKind(member) != agent.ResourceKindStandaloneAgent {
			return fmt.Errorf("node agent %s must be a standalone agent", node.AgentID)
		}
		agentsByID[node.AgentID] = member
	}
	graph.EntryAgentID = strings.TrimSpace(graph.EntryAgentID)
	if _, exists := agentsByID[graph.EntryAgentID]; !exists {
		return errors.New("entry_agent_id must reference an agent in nodes")
	}

	adjacency := make(map[string][]string, len(graph.Nodes))
	edgePairs := make(map[string]struct{}, len(graph.Edges))
	outgoingNames := make(map[string]map[string]struct{}, len(graph.Nodes))
	for i := range graph.Edges {
		edge := &graph.Edges[i]
		edge.SourceAgentID = strings.TrimSpace(edge.SourceAgentID)
		edge.TargetAgentID = strings.TrimSpace(edge.TargetAgentID)
		edge.SourcePort, edge.TargetPort = effectiveTeamEdgePorts(edge.SourcePort, edge.TargetPort)
		edge.ToolName = strings.TrimSpace(edge.ToolName)
		edge.Description = strings.TrimSpace(edge.Description)
		edge.Instructions = strings.TrimSpace(edge.Instructions)
		if _, exists := agentsByID[edge.SourceAgentID]; !exists {
			return fmt.Errorf("edges[%d].source_agent_id must reference an agent in nodes", i)
		}
		if _, exists := agentsByID[edge.TargetAgentID]; !exists {
			return fmt.Errorf("edges[%d].target_agent_id must reference an agent in nodes", i)
		}
		if edge.SourceAgentID == edge.TargetAgentID {
			return fmt.Errorf("edges[%d] cannot delegate an agent to itself", i)
		}
		if !validTeamEdgePort(edge.SourcePort) {
			return fmt.Errorf("edges[%d].source_port must be one of top, right, bottom, or left", i)
		}
		if !validTeamEdgePort(edge.TargetPort) {
			return fmt.Errorf("edges[%d].target_port must be one of top, right, bottom, or left", i)
		}
		if !toolNameRe.MatchString(edge.ToolName) {
			return fmt.Errorf("edges[%d].tool_name %q must match [A-Za-z0-9_-]{1,64}", i, edge.ToolName)
		}
		if edge.Description == "" {
			return fmt.Errorf("edges[%d].description is required", i)
		}
		pair := edge.SourceAgentID + "\x00" + edge.TargetAgentID
		if _, exists := edgePairs[pair]; exists {
			return fmt.Errorf("duplicate delegation from %s to %s", edge.SourceAgentID, edge.TargetAgentID)
		}
		edgePairs[pair] = struct{}{}
		if outgoingNames[edge.SourceAgentID] == nil {
			outgoingNames[edge.SourceAgentID] = make(map[string]struct{})
		}
		if _, exists := outgoingNames[edge.SourceAgentID][edge.ToolName]; exists {
			return fmt.Errorf("edge tool_name %q collides with another delegation from agent %s", edge.ToolName, edge.SourceAgentID)
		}
		for _, toolName := range agentsByID[edge.SourceAgentID].Tools {
			if edge.ToolName == toolName {
				return fmt.Errorf("edge tool_name %q collides with a tool on agent %s", edge.ToolName, edge.SourceAgentID)
			}
		}
		if h.validator.isCatalogTool(edge.ToolName) {
			return fmt.Errorf("edge tool_name %q collides with a registered tool", edge.ToolName)
		}
		outgoingNames[edge.SourceAgentID][edge.ToolName] = struct{}{}
		adjacency[edge.SourceAgentID] = append(adjacency[edge.SourceAgentID], edge.TargetAgentID)
	}

	state := make(map[string]uint8, len(graph.Nodes))
	longestPath := make(map[string]int, len(graph.Nodes))
	var visit func(string) (int, error)
	visit = func(agentID string) (int, error) {
		if state[agentID] == 1 {
			return 0, errors.New("team graph must not contain a delegation cycle")
		}
		if state[agentID] == 2 {
			return longestPath[agentID], nil
		}
		state[agentID] = 1
		depth := 0
		for _, target := range adjacency[agentID] {
			childDepth, err := visit(target)
			if err != nil {
				return 0, err
			}
			if childDepth+1 > depth {
				depth = childDepth + 1
			}
		}
		state[agentID] = 2
		longestPath[agentID] = depth
		return depth, nil
	}
	depth, err := visit(graph.EntryAgentID)
	if err != nil {
		return err
	}
	if len(state) != len(graph.Nodes) {
		return errors.New("every team node must be reachable from entry_agent_id")
	}
	if depth > maxTeamPathDepth {
		return fmt.Errorf("delegation path from entry_agent_id cannot exceed depth %d", maxTeamPathDepth)
	}
	return nil
}

func validCanvasCoordinate(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= maxCanvasCoordinate
}

func effectiveTeamEdgePorts(sourcePort, targetPort string) (string, string) {
	sourcePort = strings.TrimSpace(sourcePort)
	targetPort = strings.TrimSpace(targetPort)
	if sourcePort == "" {
		sourcePort = "right"
	}
	if targetPort == "" {
		targetPort = "left"
	}
	return sourcePort, targetPort
}

func validTeamEdgePort(port string) bool {
	switch port {
	case "top", "right", "bottom", "left":
		return true
	default:
		return false
	}
}

func teamGraphFromJSON(entryAgentID string, nodes []AgentTeamNodeJSON, edges []AgentTeamEdgeJSON) *agent.TeamGraph {
	return &agent.TeamGraph{
		EntryAgentID: strings.TrimSpace(entryAgentID), Nodes: teamNodesFromJSON(nodes), Edges: teamEdgesFromJSON(edges),
	}
}

func teamNodesFromJSON(nodes []AgentTeamNodeJSON) []agent.TeamNode {
	result := make([]agent.TeamNode, len(nodes))
	for i, node := range nodes {
		result[i] = agent.TeamNode{
			AgentID:  strings.TrimSpace(node.AgentID),
			Position: agent.TeamPosition{X: node.Position.X, Y: node.Position.Y},
		}
	}
	return result
}

func teamEdgesFromJSON(edges []AgentTeamEdgeJSON) []agent.TeamEdge {
	result := make([]agent.TeamEdge, len(edges))
	for i, edge := range edges {
		result[i] = agent.TeamEdge{
			SourceAgentID: strings.TrimSpace(edge.SourceAgentID), TargetAgentID: strings.TrimSpace(edge.TargetAgentID),
			SourcePort: strings.TrimSpace(edge.SourcePort), TargetPort: strings.TrimSpace(edge.TargetPort),
			ToolName: strings.TrimSpace(edge.ToolName), Description: strings.TrimSpace(edge.Description),
			Instructions: strings.TrimSpace(edge.Instructions),
		}
	}
	return result
}

func cloneTeamGraph(graph *agent.TeamGraph) *agent.TeamGraph {
	if graph == nil {
		return nil
	}
	copy := *graph
	copy.Nodes = append([]agent.TeamNode(nil), graph.Nodes...)
	copy.Edges = append([]agent.TeamEdge(nil), graph.Edges...)
	return &copy
}
