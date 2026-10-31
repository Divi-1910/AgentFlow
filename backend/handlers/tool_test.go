package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/handlers"
	"backend/tools"
)

func TestToolHandlerListsCatalogWithRuntimeAvailability(t *testing.T) {
	t.Parallel()
	catalog := tools.NewCatalogRegistry()
	executable := tools.NewEmptyRegistry()
	executable.Register(tools.NewCalculatorTool())

	recorder := httptest.NewRecorder()
	handlers.NewToolHandler(catalog, executable).List(
		recorder,
		httptest.NewRequest(http.MethodGet, "/api/tools", nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var response []handlers.ToolResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response) == 0 {
		t.Fatal("expected embedded tools")
	}
	byName := make(map[string]handlers.ToolResponse, len(response))
	for _, entry := range response {
		byName[entry.Name] = entry
		if len(entry.Parameters) == 0 || !json.Valid(entry.Parameters) {
			t.Fatalf("tool %q has invalid parameters: %s", entry.Name, entry.Parameters)
		}
	}
	if !byName["calculator"].Available {
		t.Fatal("calculator should be available")
	}
	if byName["web_search"].Available {
		t.Fatal("web_search should be catalogued but unavailable")
	}
}

func TestToolHandlerReturnsEmptyArray(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	handlers.NewToolHandler(tools.NewEmptyRegistry(), tools.NewEmptyRegistry()).List(
		recorder,
		httptest.NewRequest(http.MethodGet, "/api/tools", nil),
	)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "[]\n" {
		t.Fatalf("status/body = %d/%q", recorder.Code, recorder.Body.String())
	}
}
