// Package mcp is a minimal Model Context Protocol client over the
// Streamable-HTTP transport: initialize, tools/list, tools/call. It speaks
// JSON-RPC 2.0 and depends on the standard library only — it knows nothing of
// the agent/tool layers, so it can be unit-tested against an httptest.Server.
//
// Deliberately NOT supported (a 401 or any error simply surfaces to the caller,
// which degrades): stdio transport; OAuth / the MCP authorization flow;
// prompts, resources, roots, sampling, completion, logging; server-initiated
// requests; the standalone GET SSE channel; session resumption / Last-Event-ID;
// request batching. Non-text content blocks are rendered as a placeholder
// rather than failing.
package mcp

import "encoding/json"

// ToolSpec is one tool as advertised by a server's tools/list.
type ToolSpec struct {
	Name        string
	Description string
	InputSchema json.RawMessage // JSON Schema for the tool's arguments
}

// Result is the outcome of a tools/call.
type Result struct {
	Content string // concatenated text content blocks
	IsError bool   // the MCP tool reported a tool-level error
}
