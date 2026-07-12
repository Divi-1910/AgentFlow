package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"backend/llm"
	"backend/mcp"
)

// MCPToolPrefix namespaces every discovered MCP tool: mcp__<alias>__<tool>.
// Exported so the runtime can identify MCP calls (e.g. to soft-degrade a
// missing one on resume instead of hard-failing).
const MCPToolPrefix = "mcp__"

const (
	// mcpDiscoverTimeout bounds per-server discovery so dead servers add at most
	// this to a run's start (parallel across servers). Tunable.
	mcpDiscoverTimeout = 5 * time.Second
	mcpCallTimeout     = 30 * time.Second
	mcpMaxSchemaBytes  = 32 * 1024
)

// mcpToolNameRe matches the FULL namespaced name and enforces the provider
// tool-name rules (OpenAI/Anthropic: [A-Za-z0-9_-], ≤64 chars). A remote tool
// whose mcp__<alias>__<tool> name has invalid chars or is too long is skipped.
var mcpToolNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// MCPServerSpec is a resolved MCP connection (bearer already pulled from the
// env; empty for no-auth). Alias namespaces the tools as mcp__<alias>__<tool>.
type MCPServerSpec struct {
	Alias       string
	URL         string
	BearerToken string
}

// MCPTool adapts one discovered MCP tool to the Tool interface; Execute proxies
// to the server's tools/call. Safe for concurrent use — the shared *mcp.Client
// is read-only after Initialize and each call is an independent HTTP POST.
type MCPTool struct {
	client *mcp.Client
	name   string
	spec   mcp.ToolSpec
}

func newMCPTool(client *mcp.Client, alias string, spec mcp.ToolSpec) *MCPTool {
	return &MCPTool{client: client, name: MCPToolPrefix + alias + "__" + spec.Name, spec: spec}
}

func (t *MCPTool) Name() string { return t.name }

// Timeout caps each tools/call so a slow server can't hang a run. >0 ⇒ the
// runtime wraps the call context with this deadline (tool_batch.go).
func (t *MCPTool) Timeout() time.Duration { return mcpCallTimeout }

func (t *MCPTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.name,
		Description: t.spec.Description,
		Parameters:  normalizeSchema(t.spec.InputSchema),
		// Instructions left empty: MCP contributes nothing to the cached static prefix.
	}
}

// normalizeSchema returns a provider-safe JSON Schema object for a remote
// inputSchema (which is attacker-influenced): empty/null/oversized/non-object →
// {"type":"object"}; an object missing "type" gets "type":"object" added;
// a well-formed typed object is passed through verbatim.
func normalizeSchema(raw json.RawMessage) json.RawMessage {
	fallback := json.RawMessage(`{"type":"object"}`)
	if trimmed := strings.TrimSpace(string(raw)); trimmed == "" || trimmed == "null" || len(raw) > mcpMaxSchemaBytes {
		return fallback
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return fallback // not a JSON object (array/scalar/invalid)
	}
	if typeRaw, hasType := obj["type"]; hasType {
		// Provider tool parameters MUST be an object schema. A present-but-other
		// type ("array"/"string"/…) would be rejected by the provider, so fall back.
		if string(typeRaw) == `"object"` {
			return raw
		}
		return fallback
	}
	obj["type"] = json.RawMessage(`"object"`)
	patched, err := json.Marshal(obj)
	if err != nil {
		return fallback
	}
	return patched
}

func (t *MCPTool) Execute(ctx context.Context, call ToolCall) (*ToolResult, error) {
	res, err := t.client.CallTool(ctx, t.spec.Name, call.Args)
	if err != nil {
		// Transport / JSON-RPC failure → soft IsError so the model can adapt
		// (bounded by MaxSteps), matching the HTTP tool's contract. Never (nil,nil).
		return &ToolResult{
			Content: fmt.Sprintf("[tool: %s]\nError: %s", t.name, err.Error()),
			IsError: true,
		}, nil
	}
	return &ToolResult{Content: res.Content, IsError: res.IsError}, nil
}

// MCPManager discovers tools from remote MCP servers at run start.
type MCPManager struct {
	httpClient *http.Client
	validate   func(rawURL string) error // https + SSRF guard; overridable in tests
}

func NewMCPManager(httpClient *http.Client) *MCPManager {
	return NewMCPManagerWithURLValidator(httpClient, ValidateMCPServerURL)
}

// NewMCPManagerWithURLValidator permits composition tests to use local MCP
// servers while production continues to call NewMCPManager's HTTPS/SSRF
// policy. A nil validator falls back to the production policy.
func NewMCPManagerWithURLValidator(httpClient *http.Client, validate func(string) error) *MCPManager {
	if validate == nil {
		validate = ValidateMCPServerURL
	}
	return &MCPManager{
		httpClient: httpClient,
		// validate requires https + the shared SSRF guard. NOTE: like the HTTP
		// tool, the SSRF check resolves DNS at check time, not dial time — a
		// DNS-rebinding host could pass here and resolve to a private IP at the
		// actual request. Accepted inherited risk for v1 (the operator controls
		// these URLs); a dial-time IP guard would close it later.
		validate: validate,
	}
}

// ValidateMCPServerURL applies the same transport and SSRF policy used by live
// MCP discovery. Deployment loaders call it at boot so a frozen bundle cannot
// contain a URL the runtime will deterministically refuse later.
func ValidateMCPServerURL(rawURL string) error {
	if err := ValidateMCPServerURLSyntax(rawURL); err != nil {
		return err
	}
	return checkSSRF(rawURL, defaultBlockedCIDRs())
}

// ValidateMCPServerURLSyntax performs publication-safe validation without DNS
// or network access. Full runtime validation adds the SSRF resolution check.
func ValidateMCPServerURLSyntax(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid MCP url: %w", err)
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("MCP url must be https, got %q", parsed.Scheme)
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return fmt.Errorf("MCP url requires a host")
	}
	if parsed.User != nil {
		return fmt.Errorf("MCP url must not contain userinfo")
	}
	return nil
}

// Discover connects to each server in parallel (per-server timeout), lists its
// tools, and returns the adapters plus the aliases that were unreachable. It
// NEVER returns a fatal error — a failed server degrades to "unavailable".
func (m *MCPManager) Discover(ctx context.Context, specs []MCPServerSpec) (toolset []Tool, unavailable []string) {
	type result struct {
		tools       []Tool
		failedAlias string
	}
	// Each goroutine writes its own index (disjoint elements ⇒ no mutex); results
	// are flattened in config order so tool/<mcp_status> ordering is deterministic.
	results := make([]result, len(specs))
	var wg sync.WaitGroup
	for i, spec := range specs {
		wg.Add(1)
		go func(i int, spec MCPServerSpec) {
			defer wg.Done()
			discovered, err := m.discoverOne(ctx, spec)
			if err != nil {
				results[i] = result{failedAlias: spec.Alias}
				return
			}
			results[i] = result{tools: discovered}
		}(i, spec)
	}
	wg.Wait()
	for _, r := range results {
		toolset = append(toolset, r.tools...)
		if r.failedAlias != "" {
			unavailable = append(unavailable, r.failedAlias)
		}
	}
	return toolset, unavailable
}

func (m *MCPManager) discoverOne(ctx context.Context, spec MCPServerSpec) ([]Tool, error) {
	if err := m.validate(spec.URL); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, mcpDiscoverTimeout)
	defer cancel()
	client := mcp.NewClient(m.httpClient, spec.URL, spec.BearerToken)
	if err := client.Initialize(cctx); err != nil {
		return nil, err
	}
	specs, err := client.ListTools(cctx)
	if err != nil {
		return nil, err
	}
	out := make([]Tool, 0, len(specs))
	for _, ts := range specs {
		tool := newMCPTool(client, spec.Alias, ts)
		if !mcpToolNameRe.MatchString(tool.name) {
			continue // provider-invalid chars or full name too long → skip this tool
		}
		out = append(out, tool)
	}
	return out, nil
}
