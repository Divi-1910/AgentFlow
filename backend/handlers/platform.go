package handlers

import "net/http"

type PlatformCapabilities struct {
	ManagedDeployments bool `json:"managed_deployments"`
	RuntimeProxy       bool `json:"runtime_proxy"`
	StudioExecution    bool `json:"studio_execution"`
}

type PlatformHandler struct{ capabilities PlatformCapabilities }

func NewPlatformHandler(managedDeployments bool) *PlatformHandler {
	return &PlatformHandler{capabilities: PlatformCapabilities{
		ManagedDeployments: managedDeployments,
		RuntimeProxy:       managedDeployments,
		StudioExecution:    true,
	}}
}

func (h *PlatformHandler) Capabilities(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.capabilities)
}
