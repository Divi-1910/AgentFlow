package deployment

import (
	"context"
	"fmt"

	"backend/agent"
)

type AgentReader struct {
	userID string
	agents map[string]*agent.Agent
}

func NewAgentReader(bundle *Bundle, syntheticUserID string) *AgentReader {
	r := &AgentReader{userID: syntheticUserID, agents: make(map[string]*agent.Agent, len(bundle.Agents))}
	for _, cfg := range bundle.Agents {
		r.agents[cfg.ID] = cfg.Agent()
	}
	return r
}

func (r *AgentReader) GetByID(_ context.Context, agentID, userID string) (*agent.Agent, error) {
	if userID != r.userID {
		return nil, fmt.Errorf("agent not found")
	}
	return r.GetByIDSystem(context.Background(), agentID)
}

func (r *AgentReader) GetByIDSystem(_ context.Context, agentID string) (*agent.Agent, error) {
	a, ok := r.agents[agentID]
	if !ok {
		return nil, fmt.Errorf("agent not found")
	}
	return cloneAgent(a), nil
}

func cloneAgent(a *agent.Agent) *agent.Agent {
	copy := *a
	copy.Tools = append([]string(nil), a.Tools...)
	copy.Delegates = append([]agent.DelegateConfig(nil), a.Delegates...)
	copy.MCPServers = append([]agent.MCPServerConfig(nil), a.MCPServers...)
	return &copy
}
