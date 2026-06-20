package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"backend/agent"
	"backend/tools"
)

// toolNameRe constrains delegate tool names to provider-safe identifiers so an
// accepted config can't fail provider-side later.
var toolNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// DelegateConfigJSON is the request/response form of a delegate configuration.
type DelegateConfigJSON struct {
	AgentID      string `json:"agent_id"`
	ToolName     string `json:"tool_name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions,omitempty"`
}

// MCPServerConfigJSON is the request/response form of an MCP server config.
// bearer_env is the env-var NAME holding the token — the token value itself is
// never accepted or returned here (no secrets cross the API or live in Mongo).
type MCPServerConfigJSON struct {
	Alias     string `json:"alias"`
	URL       string `json:"url"`
	BearerEnv string `json:"bearer_env,omitempty"`
}

// agentReader is the read-only subset used by the thread/message/run handlers,
// which only ever load agents (never mutate them).
type agentReader interface {
	GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error)
	GetByIDSystem(ctx context.Context, agentID string) (*agent.Agent, error)
}

// agentStore is the full read/write agent store used by AgentHandler (the
// Studio's agent CRUD). The runtime/dispatcher never depend on this — they use
// the narrower dispatcher.AgentReader.
type agentStore interface {
	agentReader
	Create(ctx context.Context, userID string, a *agent.Agent) (*agent.Agent, error)
	ListByUser(ctx context.Context, userID string) ([]*agent.Agent, error)
	Update(ctx context.Context, agentID, userID string, input agent.UpdateAgentInput) (*agent.Agent, error)
	Delete(ctx context.Context, agentID, userID string) error
}

type AgentHandler struct {
	agentRepo    agentStore
	toolRegistry *tools.ToolRegistry
}

func NewAgentHandler(agentRepo agentStore, toolRegistry *tools.ToolRegistry) *AgentHandler {
	return &AgentHandler{
		agentRepo:    agentRepo,
		toolRegistry: toolRegistry,
	}
}

type CreateAgentRequest struct {
	Name               string                `json:"name"`
	Description        string                `json:"description"`
	Provider           string                `json:"provider"`
	Model              string                `json:"model"`
	SystemPrompt       string                `json:"system_prompt"`
	Tools              []string              `json:"tools"`
	Delegates          []DelegateConfigJSON  `json:"delegates"`
	MCPServers         []MCPServerConfigJSON `json:"mcp_servers"`
	ContextWindow      *int                  `json:"context_window"`
	ContextKeepRatio   *float64              `json:"context_keep_ratio"`
	SummarizationModel string                `json:"summarization_model"`
	MaxSteps           *int                  `json:"max_steps"`
	Temperature        *float64              `json:"temperature"`
	MaxTokens          *int                  `json:"max_tokens"`
	MaxRuns            *int                  `json:"max_runs"`
}

type UpdateAgentRequest struct {
	Name               *string                `json:"name"`
	Description        *string                `json:"description"`
	Provider           *string                `json:"provider"`
	Model              *string                `json:"model"`
	SystemPrompt       *string                `json:"system_prompt"`
	Tools              *[]string              `json:"tools"`
	Delegates          *[]DelegateConfigJSON  `json:"delegates"`
	MCPServers         *[]MCPServerConfigJSON `json:"mcp_servers"`
	ContextKeepRatio   *float64               `json:"context_keep_ratio"`
	SummarizationModel *string                `json:"summarization_model"`
	MaxSteps           *int                   `json:"max_steps"`
	Temperature        *float64               `json:"temperature"`
	MaxTokens          *int                   `json:"max_tokens"`
	MaxRuns            *int                   `json:"max_runs"`
}

type AgentResponse struct {
	ID                 string                `json:"id"`
	Name               string                `json:"name"`
	Description        string                `json:"description,omitempty"`
	Provider           string                `json:"provider"`
	Model              string                `json:"model"`
	SystemPrompt       string                `json:"system_prompt"`
	Tools              []string              `json:"tools"`
	Delegates          []DelegateConfigJSON  `json:"delegates,omitempty"`
	MCPServers         []MCPServerConfigJSON `json:"mcp_servers,omitempty"`
	ContextWindow      int                   `json:"context_window"`
	ContextKeepRatio   float64               `json:"context_keep_ratio"`
	SummarizationModel string                `json:"summarization_model,omitempty"`
	MaxSteps           int                   `json:"max_steps"`
	Temperature        float64               `json:"temperature"`
	MaxTokens          int                   `json:"max_tokens"`
	MaxRuns            int                   `json:"max_runs"`
	CreatedAt          string                `json:"created_at"`
}

func toAgentResponse(a *agent.Agent) AgentResponse {
	return AgentResponse{
		ID:                 a.ID,
		Name:               a.Name,
		Description:        a.Description,
		Provider:           a.Provider,
		Model:              a.Model,
		SystemPrompt:       a.SystemPrompt,
		Tools:              a.Tools,
		Delegates:          delegatesToJSON(a.Delegates),
		MCPServers:         mcpServersToJSON(a.MCPServers),
		ContextWindow:      a.ContextWindow,
		ContextKeepRatio:   a.ContextKeepRatio,
		SummarizationModel: a.SummarizationModel,
		MaxSteps:           a.MaxSteps,
		Temperature:        a.Temperature,
		MaxTokens:          a.MaxTokens,
		MaxRuns:            resolveAgentMaxRuns(a.MaxRuns),
		CreatedAt:          a.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func resolveInt(v *int, def int) int {
	if v != nil {
		return *v
	}
	return def
}

func resolveFloat(v *float64, def float64) float64 {
	if v != nil {
		return *v
	}
	return def
}

func resolveAgentMaxRuns(v int) int {
	if v <= 0 {
		return agent.DefaultMaxTaskRuns
	}
	return v
}

func validatePositiveInt(name string, v *int) error {
	if v != nil && *v <= 0 {
		return fmt.Errorf("%s must be greater than 0", name)
	}
	return nil
}

func (h *AgentHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req CreateAgentRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.Name == "" || req.Provider == "" || req.Model == "" || req.SystemPrompt == "" {
		writeError(w, http.StatusBadRequest, "name, provider, model, and system_prompt are required")
		return
	}

	if req.Tools == nil {
		req.Tools = []string{}
	}
	if err := h.validateTools(req.Tools); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validatePositiveInt("max_runs", req.MaxRuns); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	delegates := toDelegateConfigs(req.Delegates)
	// thisAgentID is empty on create (id not yet assigned); self-delegate is
	// impossible (a self-reference can't resolve) and is backstopped by the
	// runtime cycle guard.
	if err := h.validateDelegates(r.Context(), userID, "", req.Tools, delegates); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	mcpServers := toMCPServerConfigs(req.MCPServers)
	if err := validateMCPServers(mcpServers); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	a := &agent.Agent{
		Name:               req.Name,
		Description:        req.Description,
		Provider:           req.Provider,
		Model:              req.Model,
		SystemPrompt:       req.SystemPrompt,
		Tools:              req.Tools,
		Delegates:          delegates,
		MCPServers:         mcpServers,
		SummarizationModel: req.SummarizationModel,
		MaxSteps:           resolveInt(req.MaxSteps, agent.DefaultMaxSteps),
		MaxTokens:          resolveInt(req.MaxTokens, agent.DefaultMaxTokens),
		MaxRuns:            resolveInt(req.MaxRuns, agent.DefaultMaxTaskRuns),
		ContextWindow:      resolveInt(req.ContextWindow, agent.DefaultContextWindow),
		Temperature:        resolveFloat(req.Temperature, agent.DefaultTemperature),
		ContextKeepRatio:   resolveFloat(req.ContextKeepRatio, agent.DefaultContextKeepRatio),
	}

	created, err := h.agentRepo.Create(r.Context(), userID, a)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create agent")
		return
	}

	writeJSON(w, http.StatusCreated, toAgentResponse(created))
}

func (h *AgentHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	agents, err := h.agentRepo.ListByUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agents")
		return
	}

	resp := make([]AgentResponse, len(agents))
	for i, a := range agents {
		resp[i] = toAgentResponse(a)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *AgentHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	a, err := h.agentRepo.GetByID(r.Context(), r.PathValue("id"), userID)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get agent")
		return
	}
	writeJSON(w, http.StatusOK, toAgentResponse(a))
}

func (h *AgentHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req UpdateAgentRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	agentID := r.PathValue("id")
	input := agent.UpdateAgentInput{
		Name:               req.Name,
		Description:        req.Description,
		Provider:           req.Provider,
		Model:              req.Model,
		SystemPrompt:       req.SystemPrompt,
		Tools:              req.Tools,
		Temperature:        req.Temperature,
		MaxSteps:           req.MaxSteps,
		MaxTokens:          req.MaxTokens,
		MaxRuns:            req.MaxRuns,
		ContextKeepRatio:   req.ContextKeepRatio,
		SummarizationModel: req.SummarizationModel,
	}
	if err := validatePositiveInt("max_runs", req.MaxRuns); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Tools != nil {
		if err := h.validateTools(*req.Tools); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if req.Delegates != nil {
		delegates := toDelegateConfigs(*req.Delegates)
		// Determine the effective tool list for collision checks: the new
		// Tools if provided, else the agent's current Tools.
		effectiveTools, err := h.effectiveToolsForUpdate(r.Context(), agentID, userID, req.Tools)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load agent for validation")
			return
		}
		if err := h.validateDelegates(r.Context(), userID, agentID, effectiveTools, delegates); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		input.Delegates = &delegates
	}
	if req.MCPServers != nil {
		mcpServers := toMCPServerConfigs(*req.MCPServers)
		if err := validateMCPServers(mcpServers); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		input.MCPServers = &mcpServers
	}

	updated, err := h.agentRepo.Update(r.Context(), agentID, userID, input)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update agent")
		return
	}
	writeJSON(w, http.StatusOK, toAgentResponse(updated))
}

func (h *AgentHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if err := h.agentRepo.Delete(r.Context(), r.PathValue("id"), userID); err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete agent")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "agent deleted"})
}

func (h *AgentHandler) validateTools(toolNames []string) error {
	seen := make(map[string]bool, len(toolNames))
	for _, name := range toolNames {
		if !h.toolRegistry.Has(name) {
			return errors.New("unknown tool: " + name)
		}
		if seen[name] {
			return errors.New("duplicate tool: " + name)
		}
		seen[name] = true
	}
	return nil
}

func toDelegateConfigs(in []DelegateConfigJSON) []agent.DelegateConfig {
	if len(in) == 0 {
		return nil
	}
	out := make([]agent.DelegateConfig, len(in))
	for i, d := range in {
		out[i] = agent.DelegateConfig{
			AgentID:      d.AgentID,
			ToolName:     d.ToolName,
			Description:  d.Description,
			Instructions: d.Instructions,
		}
	}
	return out
}

func delegatesToJSON(in []agent.DelegateConfig) []DelegateConfigJSON {
	if len(in) == 0 {
		return nil
	}
	out := make([]DelegateConfigJSON, len(in))
	for i, d := range in {
		out[i] = DelegateConfigJSON{
			AgentID:      d.AgentID,
			ToolName:     d.ToolName,
			Description:  d.Description,
			Instructions: d.Instructions,
		}
	}
	return out
}

func toMCPServerConfigs(in []MCPServerConfigJSON) []agent.MCPServerConfig {
	if len(in) == 0 {
		return nil
	}
	out := make([]agent.MCPServerConfig, len(in))
	for i, m := range in {
		out[i] = agent.MCPServerConfig{Alias: m.Alias, URL: m.URL, BearerEnv: m.BearerEnv}
	}
	return out
}

func mcpServersToJSON(in []agent.MCPServerConfig) []MCPServerConfigJSON {
	if len(in) == 0 {
		return nil
	}
	out := make([]MCPServerConfigJSON, len(in))
	for i, m := range in {
		// Only alias/url/bearer_env are ever returned — never a resolved token.
		out[i] = MCPServerConfigJSON{Alias: m.Alias, URL: m.URL, BearerEnv: m.BearerEnv}
	}
	return out
}

// validateMCPServers enforces provider-safe, unique aliases (so the namespaced
// mcp__<alias>__<tool> stays valid) and a non-empty url. It does NOT require
// bearer_env to resolve — the env var may only be present in the runtime.
func validateMCPServers(servers []agent.MCPServerConfig) error {
	if len(servers) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(servers))
	for _, s := range servers {
		if !toolNameRe.MatchString(s.Alias) {
			return fmt.Errorf("mcp server alias %q must match [A-Za-z0-9_-]{1,64}", s.Alias)
		}
		if seen[s.Alias] {
			return fmt.Errorf("duplicate mcp server alias %q", s.Alias)
		}
		seen[s.Alias] = true
		if strings.TrimSpace(s.URL) == "" {
			return fmt.Errorf("mcp server %q requires a url", s.Alias)
		}
	}
	return nil
}

// effectiveToolsForUpdate returns the tool list to validate delegate-name
// collisions against: the incoming Tools if the update sets them, else the
// agent's current Tools.
func (h *AgentHandler) effectiveToolsForUpdate(ctx context.Context, agentID, userID string, newTools *[]string) ([]string, error) {
	if newTools != nil {
		return *newTools, nil
	}
	a, err := h.agentRepo.GetByID(ctx, agentID, userID)
	if err != nil {
		return nil, err
	}
	return a.Tools, nil
}

// validateDelegates enforces provider-safe tool names, no collisions (against
// tools, other delegates, or any registered tool), same-user ownership of the
// target, and (on update) no self-delegate.
func (h *AgentHandler) validateDelegates(ctx context.Context, userID, thisAgentID string, toolNames []string, delegates []agent.DelegateConfig) error {
	if len(delegates) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(toolNames))
	for _, t := range toolNames {
		seen[t] = true
	}
	for _, d := range delegates {
		if d.AgentID == "" {
			return errors.New("delegate agent_id is required")
		}
		if !toolNameRe.MatchString(d.ToolName) {
			return fmt.Errorf("delegate tool_name %q must match [A-Za-z0-9_-]{1,64}", d.ToolName)
		}
		if seen[d.ToolName] {
			return fmt.Errorf("delegate tool_name %q collides with another tool or delegate", d.ToolName)
		}
		if h.toolRegistry.Has(d.ToolName) {
			return fmt.Errorf("delegate tool_name %q collides with a registered tool", d.ToolName)
		}
		seen[d.ToolName] = true
		if thisAgentID != "" && d.AgentID == thisAgentID {
			return errors.New("an agent cannot delegate to itself")
		}
		if _, err := h.agentRepo.GetByID(ctx, d.AgentID, userID); err != nil {
			return fmt.Errorf("delegate agent %s not found or not owned", d.AgentID)
		}
	}
	return nil
}
