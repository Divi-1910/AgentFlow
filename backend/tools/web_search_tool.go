package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"backend/llm"
)

type WebSearchTool struct {
	apiKey string
	client *http.Client
	cache  *dedupCache
}

func NewWebSearchTool(apiKey string, timeout time.Duration, cache *dedupCache) *WebSearchTool {
	return &WebSearchTool{
		apiKey: apiKey,
		client: &http.Client{Timeout: timeout},
		cache:  cache,
	}
}

func (t *WebSearchTool) Name() string { return "web_search" }

func (t *WebSearchTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "web_search",
		Description: "Searches the web for current information and returns a summary with top results. Use this to answer questions about recent events or find up-to-date information.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "The search query"
				},
				"max_results": {
					"type": "integer",
					"description": "Maximum number of results to return (1-10). Defaults to 5.",
					"minimum": 1,
					"maximum": 10
				}
			},
			"required": ["query"]
		}`),
	}
}

type searchArgs struct {
	Query      string `json:"query"`
	MaxResults int    `json:"max_results,omitempty"`
}

type tavilyRequest struct {
	APIKey      string `json:"api_key"`
	Query       string `json:"query"`
	MaxResults  int    `json:"max_results"`
	SearchDepth string `json:"search_depth"`
}

type tavilyResponse struct {
	Answer  string         `json:"answer"`
	Results []tavilyResult `json:"results"`
}

type tavilyResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Content string `json:"content"`
}

// Execute is idempotent on call.ID via a file-backed response cache. Tavily
// search results for a given query are stable enough that re-issuing on
// resume would usually return equivalent data, but caching the first result
// removes any drift and avoids the extra API spend.
func (t *WebSearchTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	if cached, ok := t.cache.Get(call.ID); ok {
		return cached, nil
	}
	result, err := t.executeUncached(ctx, call.Args)
	if err == nil && result != nil {
		t.cache.Put(call.ID, result)
	}
	return result, err
}

func (t *WebSearchTool) executeUncached(ctx context.Context, args json.RawMessage) (*ToolResult, error) {
	var input searchArgs
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	if strings.TrimSpace(input.Query) == "" {
		return nil, fmt.Errorf("%w: query is required", ErrInvalidArgs)
	}
	if input.MaxResults <= 0 || input.MaxResults > 10 {
		input.MaxResults = 5
	}

	payload, err := json.Marshal(tavilyRequest{
		APIKey:      t.apiKey,
		Query:       input.Query,
		MaxResults:  input.MaxResults,
		SearchDepth: "basic",
	})
	if err != nil {
		return nil, fmt.Errorf("%w: failed to build request", ErrToolExecutionFailed)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.tavily.com/search", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create request", ErrToolExecutionFailed)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: web_search]\nError: search request failed: %s", err.Error()),
			IsError: true,
		}, nil
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read response", ErrToolExecutionFailed)
	}

	if resp.StatusCode != http.StatusOK {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: web_search]\nError: Tavily returned status %d: %s",
				resp.StatusCode, string(respBytes)),
			IsError: true,
		}, nil
	}

	var tavilyResp tavilyResponse
	if err := json.Unmarshal(respBytes, &tavilyResp); err != nil {
		return nil, fmt.Errorf("%w: failed to parse Tavily response", ErrToolExecutionFailed)
	}

	return &ToolResult{
		Content: t.format(tavilyResp),
		Metadata: map[string]interface{}{
			"query":        input.Query,
			"result_count": len(tavilyResp.Results),
		},
	}, nil
}

func (t *WebSearchTool) format(r tavilyResponse) string {
	var sb strings.Builder
	sb.WriteString("[tool: web_search]")

	if r.Answer != "" {
		sb.WriteString("\nSummary:\n")
		sb.WriteString(r.Answer)
	}

	for i, res := range r.Results {
		domain := res.URL
		if parsed, err := url.Parse(res.URL); err == nil {
			domain = parsed.Hostname()
		}
		sb.WriteString(fmt.Sprintf("\n\n[%d] %s (%s)\n%s", i+1, res.Title, domain, res.Content))
	}

	return sb.String()
}
