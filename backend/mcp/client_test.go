package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// rpcReq is the decoded request shape the fake server inspects.
type rpcReq struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func decodeReq(t *testing.T, r *http.Request) rpcReq {
	t.Helper()
	var req rpcReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	return req
}

func newClient(t *testing.T, url, bearer string) *Client {
	t.Helper()
	return NewClient(&http.Client{Timeout: 5 * time.Second}, url, bearer)
}

// A full handshake + tools/list (application/json) + the header/session contract.
func TestInitializeListToolsJSON(t *testing.T) {
	var (
		mu             sync.Mutex
		sawInitialized bool
		listHadSession bool
		listHadProto   bool
		listHadAccept  bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "sess-123")
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}`, req.ID)
		case "notifications/initialized":
			mu.Lock()
			sawInitialized = true
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			mu.Lock()
			listHadSession = r.Header.Get("Mcp-Session-Id") == "sess-123"
			listHadProto = r.Header.Get("MCP-Protocol-Version") == "2025-06-18"
			listHadAccept = strings.Contains(r.Header.Get("Accept"), "application/json") &&
				strings.Contains(r.Header.Get("Accept"), "text/event-stream")
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[
				{"name":"echo","description":"echoes","inputSchema":{"type":"object","properties":{"msg":{"type":"string"}}}}
			]}}`, req.ID)
		default:
			t.Errorf("unexpected method %q", req.Method)
		}
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	ctx := context.Background()
	if err := c.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	tools, err := c.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("tools = %+v", tools)
	}
	if string(tools[0].InputSchema) == "" {
		t.Fatal("input schema not captured")
	}
	if !sawInitialized {
		t.Error("server never received notifications/initialized")
	}
	if !listHadSession {
		t.Error("tools/list did not echo Mcp-Session-Id")
	}
	if !listHadProto {
		t.Error("tools/list did not echo MCP-Protocol-Version")
	}
	if !listHadAccept {
		t.Error("Accept header did not advertise both content types")
	}
}

// tools/call delivered as text/event-stream, with an interleaved server
// notification the client must skip, plus the bearer header.
func TestCallToolEventStreamAndBearer(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		if req.Method == "tools/call" {
			gotAuth = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			// A server-initiated notification (no id) precedes the real response.
			io.WriteString(w, "event: message\n")
			io.WriteString(w, `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}`+"\n\n")
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hello \"},{\"type\":\"text\",\"text\":\"world\"}],\"isError\":false}}\n\n", req.ID)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{}}`, req.ID)
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "secret-token")
	res, err := c.CallTool(context.Background(), "echo", json.RawMessage(`{"msg":"hi"}`))
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.Content != "hello world" {
		t.Fatalf("content = %q (want concatenated text blocks)", res.Content)
	}
	if res.IsError {
		t.Fatal("unexpected IsError")
	}
	if gotAuth != "Bearer secret-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
}

// A JSON-RPC error object surfaces as a Go error (caller degrades to IsError).
func TestCallToolRPCError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"bad params"}}`, req.ID)
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	if _, err := c.CallTool(context.Background(), "echo", nil); err == nil {
		t.Fatal("expected error from JSON-RPC error object")
	}
}

// A tool-level error (isError:true) is NOT a Go error — it's carried in Result.
func TestCallToolToolError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"nope"}],"isError":true}}`, req.ID)
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	res, err := c.CallTool(context.Background(), "echo", nil)
	if err != nil {
		t.Fatalf("tool-level error must not be a transport error: %v", err)
	}
	if !res.IsError || res.Content != "nope" {
		t.Fatalf("res = %+v", res)
	}
}

// nextCursor pagination accumulates across pages.
func TestListToolsPagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		w.Header().Set("Content-Type", "application/json")
		var p struct {
			Cursor string `json:"cursor"`
		}
		_ = json.Unmarshal(req.Params, &p)
		if p.Cursor == "" {
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"a"}],"nextCursor":"p2"}}`, req.ID)
			return
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"b"}]}}`, req.ID)
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	tools, err := c.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 2 || tools[0].Name != "a" || tools[1].Name != "b" {
		t.Fatalf("pagination tools = %+v", tools)
	}
}

// A JSON response carrying a mismatched id is rejected (no cross-call attribution).
func TestJSONResponseIDMismatchRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":999,"result":{}}`) // request id is 1
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	if err := c.Initialize(context.Background()); err == nil {
		t.Fatal("expected rejection of a mismatched response id")
	}
}

// A successful result with no id is rejected (a result must echo the request id).
func TestJSONResultMissingIDRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","result":{}}`) // success, NO id
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	if err := c.Initialize(context.Background()); err == nil {
		t.Fatal("expected rejection of a successful result with no id")
	}
}

// An error response with a null id is tolerated (spec allows it) and surfaces
// the RPC error rather than an id-mismatch error.
func TestJSONErrorNullIDTolerated(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}`)
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	err := c.Initialize(context.Background())
	if err == nil {
		t.Fatal("expected the rpc error to surface")
	}
	if strings.Contains(err.Error(), "id mismatch") {
		t.Fatalf("null-id error response must be tolerated, not rejected as a mismatch: %v", err)
	}
}

// Non-2xx (e.g. a 401) becomes a transport error so the caller degrades.
func TestHTTPErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "")
	if err := c.Initialize(context.Background()); err == nil {
		t.Fatal("expected error on 401")
	}
}
