package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"backend/llm"
)

const maxHTTPResponseSize = 32 * 1024

type HTTPTool struct {
	client  *http.Client
	blocked []*net.IPNet
	cache   *dedupCache
}

func NewHTTPTool(timeout time.Duration, cache *dedupCache) *HTTPTool {
	return &HTTPTool{
		client:  &http.Client{Timeout: timeout},
		blocked: defaultBlockedCIDRs(),
		cache:   cache,
	}
}

func (t *HTTPTool) Name() string { return "http_request" }

func (t *HTTPTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "http_request",
		Description: "Makes an HTTP request to an external URL and returns the response. Use this to call external APIs or fetch data from the web.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"method": {
					"type": "string",
					"enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
					"description": "HTTP method"
				},
				"url": {
					"type": "string",
					"description": "The full URL to request"
				},
				"headers": {
					"type": "object",
					"description": "Optional HTTP headers as key-value pairs",
					"additionalProperties": {"type": "string"}
				},
				"body": {
					"type": "string",
					"description": "Optional request body for POST/PUT/PATCH"
				}
			},
			"required": ["method", "url"]
		}`),
		Instructions: "Use http_request only for endpoints the user explicitly named or that you derived from a known integration. Prefer GET for reads; for any mutating method (POST/PUT/PATCH/DELETE) confirm with the user in the same turn before calling. Always include an Accept or Content-Type header that matches what the endpoint expects, and never pass user-supplied tokens in the URL — put them in headers.",
	}
}

type httpArgs struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

func (t *HTTPTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	if cached, ok := t.cache.Get(call.ID); ok {
		return cached, nil
	}
	result, err := t.executeUncached(ctx, call.Args)
	if err == nil && result != nil {
		t.cache.Put(call.ID, result)
	}
	return result, err
}

func (t *HTTPTool) executeUncached(ctx context.Context, args json.RawMessage) (*ToolResult, error) {
	var input httpArgs
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	if input.URL == "" {
		return nil, fmt.Errorf("%w: url is required", ErrInvalidArgs)
	}
	if input.Method == "" {
		input.Method = "GET"
	}
	input.Method = strings.ToUpper(input.Method)

	if err := t.checkSSRF(input.URL); err != nil {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: http_request]\nError: %s", err.Error()),
			IsError: true,
		}, nil
	}

	var bodyReader io.Reader
	if input.Body != "" {
		bodyReader = strings.NewReader(input.Body)
	}

	req, err := http.NewRequestWithContext(ctx, input.Method, input.URL, bodyReader)
	if err != nil {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: http_request]\nError: %s", err.Error()),
			IsError: true,
		}, nil
	}

	for k, v := range input.Headers {
		req.Header.Set(k, v)
	}

	resp, err := t.client.Do(req)
	if err != nil {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: http_request]\nError: request failed: %s", err.Error()),
			IsError: true,
		}, nil
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, maxHTTPResponseSize)
	bodyBytes, err := io.ReadAll(limited)
	if err != nil {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: http_request]\nError: failed to read response body: %s", err.Error()),
			IsError: true,
		}, nil
	}

	truncationNote := ""
	if int64(len(bodyBytes)) == maxHTTPResponseSize {
		truncationNote = "\n[response truncated at 32KB]"
	}

	contentType := resp.Header.Get("Content-Type")
	if idx := strings.Index(contentType, ";"); idx != -1 {
		contentType = strings.TrimSpace(contentType[:idx])
	}

	return &ToolResult{
		Content: fmt.Sprintf("[tool: http_request]\nStatus: %d\nContent-Type: %s\nBody: %s%s",
			resp.StatusCode, contentType, string(bodyBytes), truncationNote),
		Metadata: map[string]interface{}{
			"status_code":  resp.StatusCode,
			"url":          input.URL,
			"method":       input.Method,
			"content_type": contentType,
		},
	}, nil
}

// checkSSRF delegates to the shared package-level guard using this tool's
// blocklist. Kept as a method so existing call sites/tests are unchanged.
func (t *HTTPTool) checkSSRF(rawURL string) error {
	return checkSSRF(rawURL, t.blocked)
}
