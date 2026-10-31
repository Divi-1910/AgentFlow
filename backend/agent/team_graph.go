package agent

import "fmt"

// EffectiveTeamAgent applies Team-owned outgoing edges to a reusable Agent
// without mutating either persisted resource. Callers remain responsible for
// loading both resources with the appropriate ownership boundary.
func EffectiveTeamAgent(team, base *Agent, requestedAgentID string) (*Agent, error) {
	if team == nil || EffectiveResourceKind(team) != ResourceKindAgentTeam || team.TeamGraph == nil {
		return nil, fmt.Errorf("agent: team has no executable graph")
	}
	agentID := requestedAgentID
	if requestedAgentID == team.ID {
		agentID = team.TeamGraph.EntryAgentID
	}
	isMember := false
	for _, node := range team.TeamGraph.Nodes {
		if node.AgentID == agentID {
			isMember = true
			break
		}
	}
	if !isMember {
		return nil, fmt.Errorf("agent: %s is not a member of team %s", agentID, team.ID)
	}
	if base == nil || base.ID != agentID || EffectiveResourceKind(base) != ResourceKindStandaloneAgent {
		return nil, fmt.Errorf("agent: team member %s is not a standalone agent", agentID)
	}
	resolved := *base
	resolved.Tools = append([]string(nil), base.Tools...)
	resolved.MCPServers = append([]MCPServerSelection(nil), base.MCPServers...)
	resolved.MCPConnections = append([]MCPServerConnection(nil), base.MCPConnections...)
	resolved.Delegates = make([]DelegateConfig, 0)
	for _, edge := range team.TeamGraph.Edges {
		if edge.SourceAgentID != agentID {
			continue
		}
		resolved.Delegates = append(resolved.Delegates, DelegateConfig{
			AgentID: edge.TargetAgentID, ToolName: edge.ToolName,
			Description: edge.Description, Instructions: edge.Instructions,
		})
	}
	resolved.TeamGraph = nil
	return &resolved, nil
}
