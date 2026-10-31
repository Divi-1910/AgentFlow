package integration_test

import (
	"net/http"
	"testing"
)

func minimalAgentTeam(name, memberID string) map[string]any {
	return map[string]any{
		"name": name, "entry_agent_id": memberID,
		"nodes": []map[string]any{{
			"agent_id": memberID, "position": map[string]any{"x": 0, "y": 0},
		}},
		"edges": []any{},
	}
}

func TestAgentTeamCRUDAndResourceSeparation(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-team-crud@example.com", "password123")

	var member struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents", minimalAgent("Research Agent"), token)
	if resp.StatusCode != http.StatusCreated {
		resp.Body.Close()
		t.Fatalf("create member: expected 201, got %d", resp.StatusCode)
	}
	decodeBody(t, resp, &member)

	var created struct {
		ID           string `json:"id"`
		Kind         string `json:"kind"`
		Name         string `json:"name"`
		EntryAgentID string `json:"entry_agent_id"`
		Nodes        []struct {
			AgentID string `json:"agent_id"`
		} `json:"nodes"`
	}
	resp = e.do(t, "POST", "/api/agent-teams", minimalAgentTeam("Research Team", member.ID), token)
	if resp.StatusCode != http.StatusCreated {
		resp.Body.Close()
		t.Fatalf("create team: expected 201, got %d", resp.StatusCode)
	}
	decodeBody(t, resp, &created)
	if created.ID == "" || created.Kind != "agent_team" || len(created.Nodes) != 1 {
		t.Fatalf("unexpected create response: %+v", created)
	}
	if created.EntryAgentID != member.ID || created.Nodes[0].AgentID != member.ID {
		t.Fatalf("unexpected graph mapping: %+v", created)
	}

	resp = e.do(t, "GET", "/api/agents", nil, token)
	var agents []struct {
		ID string `json:"id"`
	}
	decodeBody(t, resp, &agents)
	if resp.StatusCode != http.StatusOK || len(agents) != 1 || agents[0].ID != member.ID {
		t.Fatalf("standalone list leaked or omitted a resource: status=%d agents=%+v", resp.StatusCode, agents)
	}

	resp = e.do(t, "GET", "/api/agent-teams", nil, token)
	var teams []struct {
		ID string `json:"id"`
	}
	decodeBody(t, resp, &teams)
	if resp.StatusCode != http.StatusOK || len(teams) != 1 || teams[0].ID != created.ID {
		t.Fatalf("team list leaked or omitted a resource: status=%d teams=%+v", resp.StatusCode, teams)
	}

	resp = e.do(t, "GET", "/api/agents/"+created.ID, nil, token)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("team through standalone endpoint: expected 404, got %d", resp.StatusCode)
	}

	newName := "Updated Research Team"
	resp = e.do(t, "PATCH", "/api/agent-teams/"+created.ID, map[string]any{
		"name": newName,
	}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("update team: expected 200, got %d", resp.StatusCode)
	}
	var updated struct {
		Name  string `json:"name"`
		Nodes []any  `json:"nodes"`
	}
	decodeBody(t, resp, &updated)
	if updated.Name != newName || len(updated.Nodes) != 1 {
		t.Fatalf("unexpected update response: %+v", updated)
	}

	resp = e.do(t, "DELETE", "/api/agent-teams/"+created.ID, nil, token)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete team: expected 200, got %d", resp.StatusCode)
	}

	resp = e.do(t, "GET", "/api/agent-teams/"+created.ID, nil, token)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("get deleted team: expected 404, got %d", resp.StatusCode)
	}
}

func TestAgentTeamRejectsAnotherUsersMember(t *testing.T) {
	e := newTestEnv(t)
	ownerToken := e.mustSignup(t, "agent-team-member-owner@example.com", "password123")
	teamToken := e.mustSignup(t, "agent-team-owner@example.com", "password123")

	var member struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agents", minimalAgent("Private Agent"), ownerToken)
	decodeBody(t, resp, &member)

	resp = e.do(t, "POST", "/api/agent-teams", minimalAgentTeam("Invalid Team", member.ID), teamToken)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestAgentTeamConversationRoutesEnforceResourceKind(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "agent-team-thread@example.com", "password123")
	memberID := createAgent(t, e, token, "Team Member")
	var team struct {
		ID string `json:"id"`
	}
	resp := e.do(t, "POST", "/api/agent-teams", minimalAgentTeam("Conversation Team", memberID), token)
	if resp.StatusCode != http.StatusCreated {
		resp.Body.Close()
		t.Fatalf("create team: expected 201, got %d", resp.StatusCode)
	}
	decodeBody(t, resp, &team)

	resp = e.do(t, "POST", "/api/agents/"+team.ID+"/threads", map[string]any{"title": "wrong"}, token)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("team through agent conversation route: expected 404, got %d", resp.StatusCode)
	}
	resp = e.do(t, "POST", "/api/agent-teams/"+memberID+"/threads", map[string]any{"title": "wrong"}, token)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("agent through team conversation route: expected 404, got %d", resp.StatusCode)
	}

	resp = e.do(t, "POST", "/api/agent-teams/"+team.ID+"/threads", map[string]any{"title": "Team Thread"}, token)
	if resp.StatusCode != http.StatusCreated {
		resp.Body.Close()
		t.Fatalf("create team thread: expected 201, got %d", resp.StatusCode)
	}
	var thread struct {
		ID           string `json:"id"`
		ResourceKind string `json:"resource_kind"`
	}
	decodeBody(t, resp, &thread)
	if thread.ID == "" || thread.ResourceKind != "agent_team" {
		t.Fatalf("unexpected thread response: %+v", thread)
	}

	resp = e.do(t, "PATCH", "/api/threads/"+thread.ID, map[string]any{"title": "Renamed Team Thread"}, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("rename team thread: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = e.do(t, "GET", "/api/threads/"+thread.ID, nil, token)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("get team thread: expected 200, got %d", resp.StatusCode)
	}
	var fetched struct {
		Title string `json:"title"`
	}
	decodeBody(t, resp, &fetched)
	if fetched.Title != "Renamed Team Thread" {
		t.Fatalf("thread title = %q", fetched.Title)
	}
}
