package handlers_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/handlers"
	"backend/mcp"
)

type fakeMCPServerLister struct {
	entries []mcp.CatalogEntry
	err     error
}

func (f fakeMCPServerLister) ListEnabled(context.Context) ([]mcp.CatalogEntry, error) {
	return f.entries, f.err
}

func TestMCPServerHandlerListExposesOnlySelectionMetadata(t *testing.T) {
	h := handlers.NewMCPServerHandler(fakeMCPServerLister{entries: []mcp.CatalogEntry{{
		ServerID: "fetch", Name: "Fetch", Description: "Retrieve remote content", Alias: "fetch",
		StudioURL: "http://localhost:8102/mcp", DeploymentURL: "http://fetch.mcp-system.svc/mcp", Enabled: true,
	}}})
	recorder := httptest.NewRecorder()
	h.List(recorder, httptest.NewRequest(http.MethodGet, "/api/mcp-servers", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response) != 1 || response[0]["server_id"] != "fetch" {
		t.Fatalf("response = %+v", response)
	}
	for key := range response[0] {
		if key != "server_id" && key != "name" && key != "description" && key != "alias" {
			t.Fatalf("internal catalog field %q was exposed: %+v", key, response[0])
		}
	}
}

func TestMCPServerHandlerListReturnsEmptyArray(t *testing.T) {
	h := handlers.NewMCPServerHandler(fakeMCPServerLister{})
	recorder := httptest.NewRecorder()
	h.List(recorder, httptest.NewRequest(http.MethodGet, "/api/mcp-servers", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "[]\n" {
		t.Fatalf("status/body = %d/%q", recorder.Code, recorder.Body.String())
	}
}

func TestMCPServerHandlerListHidesStorageFailure(t *testing.T) {
	h := handlers.NewMCPServerHandler(fakeMCPServerLister{err: errors.New("mongo details")})
	recorder := httptest.NewRecorder()
	h.List(recorder, httptest.NewRequest(http.MethodGet, "/api/mcp-servers", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() == "" || recorder.Body.String() == "mongo details" {
		t.Fatalf("storage error was not safely hidden: %q", recorder.Body.String())
	}
}
