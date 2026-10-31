package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
	"backend/tools"
)

const (
	testTeamID   = "507f1f77bcf86cd799439020"
	testWorkerID = "507f1f77bcf86cd799439021"
)

func newAgentTeamHandler(store *fakeAgentStore) *handlers.AgentTeamHandler {
	registry := tools.NewEmptyRegistry()
	registry.Register(tools.NewCalculatorTool())
	return handlers.NewAgentTeamHandler(
		store, registry, registry, fakeMCPServerLookup{}, fakeLLMModelLookup{}, fakeProviderAvailability{},
	)
}

func validTeamBody(t *testing.T) *bytes.Buffer {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"name": "Research Team", "entry_agent_id": testAgentID,
		"nodes": []map[string]any{
			{"agent_id": testAgentID, "position": map[string]any{"x": 0, "y": 0}},
			{"agent_id": testWorkerID, "position": map[string]any{"x": 320, "y": 80}},
		},
		"edges": []map[string]any{{
			"source_agent_id": testAgentID, "target_agent_id": testWorkerID,
			"source_port": "bottom", "target_port": "top",
			"tool_name": "researcher", "description": "Research the requested topic.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewBuffer(body)
}

func TestAgentTeamHandlerCreatesTeamOwnedGraph(t *testing.T) {
	t.Parallel()
	var captured *agent.Agent
	store := &fakeAgentStore{
		getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
			return &agent.Agent{ID: id, Kind: agent.ResourceKindStandaloneAgent}, nil
		},
		createFn: func(_ context.Context, _ string, input *agent.Agent) (*agent.Agent, error) {
			captured = input
			input.ID = testTeamID
			input.CreatedAt = time.Now()
			input.UpdatedAt = input.CreatedAt
			return input, nil
		},
	}
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/api/agent-teams", validTeamBody(t))))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if captured == nil || captured.TeamGraph == nil || len(captured.Delegates) != 0 || len(captured.TeamGraph.Edges) != 1 {
		t.Fatalf("captured team = %+v", captured)
	}
	var response handlers.AgentTeamResponse
	decodeJSON(t, recorder.Body.Bytes(), &response)
	if response.EntryAgentID != testAgentID || len(response.Nodes) != 2 || response.Edges[0].ToolName != "researcher" ||
		response.Edges[0].SourcePort != "bottom" || response.Edges[0].TargetPort != "top" {
		t.Fatalf("response = %+v", response)
	}
}

func TestAgentTeamHandlerDefaultsLegacyPortsAndRejectsUnknownPort(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
			return &agent.Agent{ID: id, Kind: agent.ResourceKindStandaloneAgent}, nil
		},
		createFn: func(_ context.Context, _ string, input *agent.Agent) (*agent.Agent, error) {
			input.ID = testTeamID
			input.CreatedAt = time.Now()
			input.UpdatedAt = input.CreatedAt
			return input, nil
		},
	}

	legacyBody := validTeamBody(t)
	var legacy map[string]any
	if err := json.Unmarshal(legacyBody.Bytes(), &legacy); err != nil {
		t.Fatal(err)
	}
	edge := legacy["edges"].([]any)[0].(map[string]any)
	delete(edge, "source_port")
	delete(edge, "target_port")
	body, _ := json.Marshal(legacy)
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/api/agent-teams", bytes.NewReader(body))))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("legacy status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var response handlers.AgentTeamResponse
	decodeJSON(t, recorder.Body.Bytes(), &response)
	if response.Edges[0].SourcePort != "right" || response.Edges[0].TargetPort != "left" {
		t.Fatalf("legacy ports = %+v", response.Edges[0])
	}

	edge["source_port"] = "diagonal"
	body, _ = json.Marshal(legacy)
	recorder = httptest.NewRecorder()
	newAgentTeamHandler(store).Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/api/agent-teams", bytes.NewReader(body))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid port status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentTeamHandlerRejectsNestedTeamNode(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		return &agent.Agent{ID: id, Kind: agent.ResourceKindAgentTeam}, nil
	}}
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/api/agent-teams", validTeamBody(t))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentTeamHandlerRejectsCycleAndUnreachableNode(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		return &agent.Agent{ID: id, Kind: agent.ResourceKindStandaloneAgent}, nil
	}}
	body, _ := json.Marshal(map[string]any{
		"name": "Cyclic", "entry_agent_id": testAgentID,
		"nodes": []map[string]any{
			{"agent_id": testAgentID, "position": map[string]any{"x": 0, "y": 0}},
			{"agent_id": testWorkerID, "position": map[string]any{"x": 1, "y": 1}},
		},
		"edges": []map[string]any{
			{"source_agent_id": testAgentID, "target_agent_id": testWorkerID, "tool_name": "worker", "description": "work"},
			{"source_agent_id": testWorkerID, "target_agent_id": testAgentID, "tool_name": "parent", "description": "return"},
		},
	})
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/api/agent-teams", bytes.NewReader(body))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentTeamHandlerRejectsPerSourceToolCollision(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
		agentTools := []string(nil)
		if id == testAgentID {
			agentTools = []string{"researcher"}
		}
		return &agent.Agent{ID: id, Kind: agent.ResourceKindStandaloneAgent, Tools: agentTools}, nil
	}}
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).Create(recorder, withUser(httptest.NewRequest(http.MethodPost, "/api/agent-teams", validTeamBody(t))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentTeamHandlerListReturnsOnlyTeams(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{listFn: func(_ context.Context, _ string) ([]*agent.Agent, error) {
		return []*agent.Agent{
			{ID: testAgentID, Kind: agent.ResourceKindStandaloneAgent, Name: "agent"},
			{ID: testTeamID, Kind: agent.ResourceKindAgentTeam, Name: "team"},
		}, nil
	}}
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).List(recorder, withUser(httptest.NewRequest(http.MethodGet, "/api/agent-teams", nil)))
	var response []handlers.AgentTeamResponse
	decodeJSON(t, recorder.Body.Bytes(), &response)
	if recorder.Code != http.StatusOK || len(response) != 1 || response[0].ID != testTeamID {
		t.Fatalf("status = %d response = %+v", recorder.Code, response)
	}
}

func TestAgentTeamHandlerUpdateReplacesGraph(t *testing.T) {
	t.Parallel()
	store := &fakeAgentStore{
		getByIDFn: func(_ context.Context, id, _ string) (*agent.Agent, error) {
			if id == testTeamID {
				return &agent.Agent{ID: id, Kind: agent.ResourceKindAgentTeam, TeamGraph: &agent.TeamGraph{EntryAgentID: testAgentID}}, nil
			}
			return &agent.Agent{ID: id, Kind: agent.ResourceKindStandaloneAgent}, nil
		},
		updateFn: func(_ context.Context, id, _ string, input agent.UpdateAgentInput) (*agent.Agent, error) {
			return &agent.Agent{ID: id, Kind: agent.ResourceKindAgentTeam, Name: "team", TeamGraph: input.TeamGraph}, nil
		},
	}
	body, _ := json.Marshal(map[string]any{
		"entry_agent_id": testAgentID,
		"nodes":          []map[string]any{{"agent_id": testAgentID, "position": map[string]any{"x": 10, "y": 20}}},
		"edges":          []any{},
	})
	request := withUser(httptest.NewRequest(http.MethodPatch, "/api/agent-teams/"+testTeamID, bytes.NewReader(body)))
	request.SetPathValue("id", testTeamID)
	recorder := httptest.NewRecorder()
	newAgentTeamHandler(store).Update(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var response handlers.AgentTeamResponse
	decodeJSON(t, recorder.Body.Bytes(), &response)
	if len(response.Nodes) != 1 || len(response.Edges) != 0 || response.Nodes[0].Position.X != 10 {
		t.Fatalf("response = %+v", response)
	}
}
