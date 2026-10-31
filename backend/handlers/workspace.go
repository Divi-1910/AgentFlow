package handlers

import (
	"context"
	"net/http"

	"backend/agent"
	"backend/deployment"
	"backend/model"
)

type workspaceStatsStore interface {
	CountTopLevelRuns(ctx context.Context, userID string, statuses []string) (int64, error)
	CountDeployments(ctx context.Context, userID string, phases []string) (int64, error)
}

type WorkspaceHandler struct {
	resources          ownedResourceLister
	models             llmModelStore
	providers          providerAvailability
	toolCatalog        toolDefinitionCatalog
	tools              toolAvailability
	mcpServers         mcpServerLister
	stats              workspaceStatsStore
	managedDeployments bool
}

func NewWorkspaceHandler(
	resources ownedResourceLister,
	models llmModelStore,
	providers providerAvailability,
	toolCatalog toolDefinitionCatalog,
	tools toolAvailability,
	mcpServers mcpServerLister,
	stats workspaceStatsStore,
	managedDeployments bool,
) *WorkspaceHandler {
	return &WorkspaceHandler{
		resources: resources, models: models, providers: providers,
		toolCatalog: toolCatalog, tools: tools, mcpServers: mcpServers,
		stats: stats, managedDeployments: managedDeployments,
	}
}

type WorkspaceResourceCounts struct {
	Agents int `json:"agents"`
	Teams  int `json:"teams"`
}

type WorkspaceRunCounts struct {
	Active int64 `json:"active"`
}

type WorkspaceDeploymentCounts struct {
	ManagedEnabled bool  `json:"managed_enabled"`
	Total          int64 `json:"total"`
	Ready          int64 `json:"ready"`
	InProgress     int64 `json:"in_progress"`
	Degraded       int64 `json:"degraded"`
	Failed         int64 `json:"failed"`
}

type WorkspaceCatalogCounts struct {
	AvailableModels     int `json:"available_models"`
	AvailableTools      int `json:"available_tools"`
	AvailableMCPServers int `json:"available_mcp_servers"`
}

type WorkspaceOverviewResponse struct {
	Resources   WorkspaceResourceCounts   `json:"resources"`
	Runs        WorkspaceRunCounts        `json:"runs"`
	Deployments WorkspaceDeploymentCounts `json:"deployments"`
	Catalog     WorkspaceCatalogCounts    `json:"catalog"`
}

func (h *WorkspaceHandler) Overview(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	resources, err := h.resources.ListByUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load workspace resources")
		return
	}
	response := WorkspaceOverviewResponse{}
	for _, resource := range resources {
		if agent.EffectiveResourceKind(resource) == agent.ResourceKindAgentTeam {
			response.Resources.Teams++
		} else {
			response.Resources.Agents++
		}
	}
	response.Runs.Active, err = h.stats.CountTopLevelRuns(r.Context(), userID, []string{
		string(model.RunStatusRunning), string(model.RunStatusCancelling),
		string(model.RunStatusResumable), string(model.RunStatusInterrupted),
		string(model.RunStatusWaitingJobs),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load workspace runs")
		return
	}
	response.Deployments.ManagedEnabled = h.managedDeployments
	if h.managedDeployments {
		if err := h.addDeploymentCounts(r.Context(), userID, &response.Deployments); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load workspace deployments")
			return
		}
	}
	models, err := h.models.ListAll(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load model catalog")
		return
	}
	availableProviders := map[string]struct{}{}
	for _, provider := range h.providers.Available() {
		availableProviders[provider] = struct{}{}
	}
	for _, entry := range models {
		if _, available := availableProviders[entry.Provider]; available {
			response.Catalog.AvailableModels++
		}
	}
	for _, definition := range h.toolCatalog.Definitions() {
		if h.tools.Has(definition.Name) {
			response.Catalog.AvailableTools++
		}
	}
	mcpServers, err := h.mcpServers.ListEnabled(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load MCP catalog")
		return
	}
	response.Catalog.AvailableMCPServers = len(mcpServers)
	writeJSON(w, http.StatusOK, response)
}

func (h *WorkspaceHandler) addDeploymentCounts(ctx context.Context, userID string, counts *WorkspaceDeploymentCounts) error {
	var err error
	counts.Total, err = h.stats.CountDeployments(ctx, userID, nil)
	if err != nil {
		return err
	}
	counts.Ready, err = h.stats.CountDeployments(ctx, userID, []string{string(deployment.DeploymentPhaseReady)})
	if err != nil {
		return err
	}
	counts.InProgress, err = h.stats.CountDeployments(ctx, userID, []string{
		string(deployment.DeploymentPhasePending), string(deployment.DeploymentPhaseProvisioning),
		string(deployment.DeploymentPhaseStarting), string(deployment.DeploymentPhaseDeleting),
	})
	if err != nil {
		return err
	}
	counts.Degraded, err = h.stats.CountDeployments(ctx, userID, []string{string(deployment.DeploymentPhaseDegraded)})
	if err != nil {
		return err
	}
	counts.Failed, err = h.stats.CountDeployments(ctx, userID, []string{string(deployment.DeploymentPhaseFailed)})
	return err
}
