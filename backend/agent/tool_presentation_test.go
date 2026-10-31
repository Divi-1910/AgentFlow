package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestToolPresentationShowsMemoryWriteContent(t *testing.T) {
	meta := toolEventMeta(
		RunContext{},
		"call-1",
		"memory_write",
		json.RawMessage(`{"content":"Prefers concise answers","type":"preference","scope":"user","importance":0.8}`),
		"",
		"",
		false,
	)

	if meta.Presentation == nil || meta.Presentation.RunningLabel != "Saving this to memory" || meta.Presentation.CompletedLabel != "Saved this to memory" {
		t.Fatalf("memory presentation labels = %#v", meta.Presentation)
	}
	if value := presentationFieldValue(meta.Presentation.Input, "Content"); value != "Prefers concise answers" {
		t.Fatalf("memory content = %q", value)
	}
	if value := presentationFieldValue(meta.Presentation.Input, "Scope"); value != "user" {
		t.Fatalf("memory scope = %q", value)
	}
}

func TestToolPresentationHidesHTTPRequestSecrets(t *testing.T) {
	args := json.RawMessage(`{
		"method":"POST",
		"url":"https://example.com/data",
		"headers":{"Authorization":"Bearer private-token","X-Trace":"trace-value"},
		"body":"private request body"
	}`)
	meta := toolEventMeta(RunContext{}, "call-2", "http_request", args, "", "", false)
	body, err := json.Marshal(meta.Presentation)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(body)
	for _, forbidden := range []string{"private-token", "trace-value", "private request body"} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("HTTP presentation leaked %q: %s", forbidden, encoded)
		}
	}
	if !strings.Contains(encoded, "Authorization, X-Trace (values hidden)") || !strings.Contains(encoded, "Request body hidden") {
		t.Fatalf("HTTP redaction summary = %s", encoded)
	}
}

func TestToolPresentationRedactsArbitraryMCPSecretKeys(t *testing.T) {
	meta := toolEventMeta(
		RunContext{MCPServerIDs: map[string]string{"weather": "open-meteo"}},
		"call-3",
		"mcp__weather__forecast",
		json.RawMessage(`{"city":"Pune","api_key":"private","nested":{"token":"also-private"}}`),
		"",
		"",
		false,
	)
	body, err := json.Marshal(meta.Presentation)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(body)
	if strings.Contains(encoded, "also-private") || strings.Contains(encoded, `"private"`) {
		t.Fatalf("MCP presentation leaked a credential: %s", encoded)
	}
	if !strings.Contains(encoded, "[redacted]") || !strings.Contains(encoded, "Pune") {
		t.Fatalf("MCP presentation did not preserve safe context: %s", encoded)
	}
}

func presentationFieldValue(fields []ToolPresentationField, label string) string {
	for _, field := range fields {
		if field.Label == label {
			return field.Value
		}
	}
	return ""
}
