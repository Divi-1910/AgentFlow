package handlers

import (
	"context"
	"net/http"

	"backend/mcp"
)

type mcpServerLister interface {
	ListEnabled(ctx context.Context) ([]mcp.CatalogEntry, error)
}

type MCPServerHandler struct {
	catalog mcpServerLister
}

func NewMCPServerHandler(catalog mcpServerLister) *MCPServerHandler {
	return &MCPServerHandler{catalog: catalog}
}

type MCPServerResponse struct {
	ServerID    string `json:"server_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Alias       string `json:"alias"`
}

func (h *MCPServerHandler) List(w http.ResponseWriter, r *http.Request) {
	entries, err := h.catalog.ListEnabled(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch MCP servers")
		return
	}
	response := make([]MCPServerResponse, len(entries))
	for i, entry := range entries {
		response[i] = MCPServerResponse{
			ServerID: entry.ServerID, Name: entry.Name,
			Description: entry.Description, Alias: entry.Alias,
		}
	}
	writeJSON(w, http.StatusOK, response)
}
