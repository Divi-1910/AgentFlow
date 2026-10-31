package handlers

import (
	"encoding/json"
	"net/http"

	"backend/llm"
)

type toolDefinitionCatalog interface {
	Definitions() []llm.ToolDefinition
}

type toolAvailability interface {
	Has(name string) bool
}

type ToolHandler struct {
	catalog   toolDefinitionCatalog
	available toolAvailability
}

func NewToolHandler(catalog toolDefinitionCatalog, available toolAvailability) *ToolHandler {
	return &ToolHandler{catalog: catalog, available: available}
}

type ToolResponse struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	Available   bool            `json:"available"`
}

func (h *ToolHandler) List(w http.ResponseWriter, _ *http.Request) {
	definitions := h.catalog.Definitions()
	response := make([]ToolResponse, len(definitions))
	for i, definition := range definitions {
		parameters := append(json.RawMessage(nil), definition.Parameters...)
		if len(parameters) == 0 {
			parameters = json.RawMessage(`{}`)
		}
		response[i] = ToolResponse{
			Name: definition.Name, Description: definition.Description,
			Parameters: parameters, Available: h.available.Has(definition.Name),
		}
	}
	writeJSON(w, http.StatusOK, response)
}
