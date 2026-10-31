package handlers_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/agent"
	"backend/handlers"
	"backend/mcp"
	"backend/model"
	"backend/tools"
)

type fakeWorkspaceStats struct{}

func (fakeWorkspaceStats) CountTopLevelRuns(context.Context, string, []string) (int64, error) {
	return 3, nil
}

func (fakeWorkspaceStats) CountDeployments(_ context.Context, _ string, phases []string) (int64, error) {
	if len(phases) == 0 {
		return 4, nil
	}
	switch phases[0] {
	case "ready":
		return 1, nil
	case "pending":
		return 2, nil
	case "degraded":
		return 1, nil
	default:
		return 0, nil
	}
}

type fakeWorkspaceMCPServers struct{}

func (fakeWorkspaceMCPServers) ListEnabled(context.Context) ([]mcp.CatalogEntry, error) {
	return []mcp.CatalogEntry{{ServerID: "math"}, {ServerID: "fetch"}}, nil
}

func TestWorkspaceOverviewReturnsProductCounts(t *testing.T) {
	t.Parallel()
	resources := &fakeAgentStore{listFn: func(context.Context, string) ([]*agent.Agent, error) {
		return []*agent.Agent{
			{ID: testAgentID, Kind: agent.ResourceKindStandaloneAgent},
			{ID: testTeamID, Kind: agent.ResourceKindAgentTeam},
		}, nil
	}}
	models := &fakeLLMModelStore{listAllFn: func(context.Context) ([]model.LLMModel, error) {
		return []model.LLMModel{{Provider: "openai"}, {Provider: "other"}}, nil
	}}
	catalog := tools.NewEmptyRegistry()
	catalog.Register(tools.NewCalculatorTool())
	executable := tools.NewEmptyRegistry()
	executable.Register(tools.NewCalculatorTool())
	h := handlers.NewWorkspaceHandler(
		resources, models, fakeProviderAvailability{providers: []string{"openai"}},
		catalog, executable, fakeWorkspaceMCPServers{}, fakeWorkspaceStats{}, true,
	)
	w := httptest.NewRecorder()
	h.Overview(w, withUser(httptest.NewRequest(http.MethodGet, "/api/workspace/overview", nil)))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var response handlers.WorkspaceOverviewResponse
	decodeJSON(t, w.Body.Bytes(), &response)
	if response.Resources.Agents != 1 || response.Resources.Teams != 1 || response.Runs.Active != 3 ||
		response.Deployments.Total != 4 || response.Deployments.Ready != 1 || response.Deployments.InProgress != 2 ||
		response.Catalog.AvailableModels != 1 || response.Catalog.AvailableTools != 1 || response.Catalog.AvailableMCPServers != 2 {
		t.Fatalf("response = %+v", response)
	}
}

func TestPlatformCapabilitiesReflectManagedDeploymentConfiguration(t *testing.T) {
	t.Parallel()
	w := httptest.NewRecorder()
	handlers.NewPlatformHandler(true).Capabilities(w, httptest.NewRequest(http.MethodGet, "/api/platform/capabilities", nil))
	var response handlers.PlatformCapabilities
	decodeJSON(t, w.Body.Bytes(), &response)
	if !response.ManagedDeployments || !response.RuntimeProxy || !response.StudioExecution {
		t.Fatalf("response = %+v", response)
	}
}
