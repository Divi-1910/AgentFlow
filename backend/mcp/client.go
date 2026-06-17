package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
)

const (
	// protocolVersion is the MCP revision we advertise on initialize. The
	// server may negotiate an older one in its response, which we then echo.
	protocolVersion = "2025-06-18"

	clientName    = "graas-agent"
	clientVersion = "0.1"

	maxResponseBytes = 5 << 20 // 5 MiB cap per HTTP response body
	maxToolsListed   = 1000    // pagination safety bound
)

// Client is a single-server MCP client. It is concurrency-safe AFTER
// Initialize: request ids are generated atomically, and sessionID/
// protocolVersion are written only during Initialize (single-threaded) and
// read-only thereafter. Callers MUST complete Initialize before issuing
// concurrent CallTool requests (the manager does: it initializes one client
// per server before the run executes tools in parallel).
type Client struct {
	httpClient *http.Client
	baseURL    string
	bearer     string

	sessionID       string
	protocolVersion string
	nextID          atomic.Int64
}

// NewClient builds a client for one MCP endpoint. bearer is the static token
// (empty for no-auth servers); it is sent as Authorization: Bearer and is never
// logged or placed in the URL.
func NewClient(httpClient *http.Client, baseURL, bearer string) *Client {
	return &Client{httpClient: httpClient, baseURL: baseURL, bearer: bearer}
}

// Initialize performs the MCP handshake: initialize → capture session id +
// negotiated protocol version → notifications/initialized.
func (c *Client) Initialize(ctx context.Context) error {
	result, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": clientName, "version": clientVersion},
	})
	if err != nil {
		return err
	}
	var ir struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(result, &ir); err != nil {
		return fmt.Errorf("mcp: parse initialize result: %w", err)
	}
	if ir.ProtocolVersion != "" {
		c.protocolVersion = ir.ProtocolVersion
	} else {
		c.protocolVersion = protocolVersion
	}
	if err := c.notify(ctx, "notifications/initialized"); err != nil {
		return err
	}
	return nil
}

// ListTools returns every tool the server advertises, following nextCursor
// pagination.
func (c *Client) ListTools(ctx context.Context) ([]ToolSpec, error) {
	var out []ToolSpec
	cursor := ""
	for {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := c.call(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var lr struct {
			Tools []struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				InputSchema json.RawMessage `json:"inputSchema"`
			} `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(result, &lr); err != nil {
			return nil, fmt.Errorf("mcp: parse tools/list result: %w", err)
		}
		for _, t := range lr.Tools {
			out = append(out, ToolSpec{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
		}
		if lr.NextCursor == "" || len(out) >= maxToolsListed {
			break
		}
		cursor = lr.NextCursor
	}
	return out, nil
}

// CallTool invokes one tool. A transport or JSON-RPC error returns a non-nil
// error; a tool-level error is carried in Result.IsError.
func (c *Client) CallTool(ctx context.Context, name string, args json.RawMessage) (Result, error) {
	if len(bytes.TrimSpace(args)) == 0 {
		args = json.RawMessage(`{}`)
	}
	result, err := c.call(ctx, "tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
	if err != nil {
		return Result{}, err
	}
	var cr struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(result, &cr); err != nil {
		return Result{}, fmt.Errorf("mcp: parse tools/call result: %w", err)
	}
	var sb strings.Builder
	for _, block := range cr.Content {
		if block.Type == "text" {
			sb.WriteString(block.Text)
			continue
		}
		fmt.Fprintf(&sb, "[non-text content omitted: %s]", block.Type)
	}
	return Result{Content: sb.String(), IsError: cr.IsError}, nil
}

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// call sends a request and returns its result, resolving transport errors,
// JSON-RPC errors, and the application/json vs text/event-stream split.
func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return nil, fmt.Errorf("mcp: marshal %s request: %w", method, err)
	}
	resp, err := c.post(ctx, body)
	if err != nil {
		return nil, err
	}
	rr, err := readResponse(resp, id)
	if err != nil {
		return nil, fmt.Errorf("mcp: %s: %w", method, err)
	}
	if rr.Error != nil {
		return nil, fmt.Errorf("mcp: %s rpc error %d: %s", method, rr.Error.Code, rr.Error.Message)
	}
	return rr.Result, nil
}

// notify sends a fire-and-forget notification (no id, no result expected).
func (c *Client) notify(ctx context.Context, method string) error {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method})
	if err != nil {
		return fmt.Errorf("mcp: marshal %s notification: %w", method, err)
	}
	resp, err := c.post(ctx, body)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

func (c *Client) post(ctx context.Context, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("mcp: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
	}
	if c.protocolVersion != "" {
		req.Header.Set("MCP-Protocol-Version", c.protocolVersion)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mcp: request failed: %w", err)
	}
	// Session id is assigned on the initialize response; capture once.
	if c.sessionID == "" {
		if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
			c.sessionID = sid
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		_ = resp.Body.Close()
		return nil, fmt.Errorf("mcp: http %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return resp, nil
}

// readResponse parses one JSON-RPC response from an application/json body or
// (for Streamable-HTTP) the first matching message in a text/event-stream body.
func readResponse(resp *http.Response, id int64) (*rpcResponse, error) {
	defer resp.Body.Close()
	body := io.LimitReader(resp.Body, maxResponseBytes)
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return readEventStream(body, id)
	}
	var rr rpcResponse
	if err := json.NewDecoder(body).Decode(&rr); err != nil {
		return nil, fmt.Errorf("decode json response: %w", err)
	}
	// A successful result MUST echo the request id. A null/absent id is tolerated
	// ONLY for error responses (a spec-compliant server may omit the id when it
	// couldn't parse the request). Anything else is a mismatch and rejected.
	if got := string(bytes.TrimSpace(rr.ID)); got != strconv.FormatInt(id, 10) {
		missing := got == "" || got == "null"
		if !(missing && rr.Error != nil) {
			return nil, fmt.Errorf("response id mismatch: got %q, want %d", got, id)
		}
	}
	return &rr, nil
}

// readEventStream scans an SSE body and returns the first data event that is a
// JSON-RPC response matching id (skipping server notifications/requests).
func readEventStream(body io.Reader, id int64) (*rpcResponse, error) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), maxResponseBytes)
	want := strconv.FormatInt(id, 10)
	var data strings.Builder
	tryParse := func() *rpcResponse {
		if data.Len() == 0 {
			return nil
		}
		payload := data.String()
		data.Reset()
		var rr rpcResponse
		if err := json.Unmarshal([]byte(payload), &rr); err != nil {
			return nil // not a JSON-RPC message — skip this event
		}
		if string(bytes.TrimSpace(rr.ID)) == want {
			return &rr
		}
		return nil
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" { // event boundary
			if rr := tryParse(); rr != nil {
				return rr, nil
			}
			continue
		}
		if after, ok := strings.CutPrefix(line, "data:"); ok {
			data.WriteString(strings.TrimSpace(after))
		}
		// other SSE fields (event:, id:, retry:) are ignored
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read event stream: %w", err)
	}
	if rr := tryParse(); rr != nil { // final event without trailing blank line
		return rr, nil
	}
	return nil, fmt.Errorf("no response matching id %d in event stream", id)
}
