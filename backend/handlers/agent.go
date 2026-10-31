package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"backend/agent"
	"backend/mcp"
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

// MCPServerSelectionJSON is the request/response form of a catalog selection.
// Connection details are owned by AgentFlow and are never accepted here.
type MCPServerSelectionJSON struct {
	ServerID string `json:"server_id"`
}

func (s *MCPServerSelectionJSON) UnmarshalJSON(data []byte) error {
	type selectionWire MCPServerSelectionJSON
	var decoded selectionWire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*s = MCPServerSelectionJSON(decoded)
	return nil
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

type mcpServerLookup interface {
	GetEnabledByIDs(ctx context.Context, serverIDs []string) (map[string]mcp.CatalogEntry, error)
}

type llmModelLookup interface {
	Exists(ctx context.Context, provider, apiModelID string) (bool, error)
}

type providerAvailability interface {
	Available() []string
}

type resourceDependencyChecker interface {
	BlockingDependencies(ctx context.Context, userID, resourceID string) ([]string, error)
}

var (
	errMCPServerCatalog = errors.New("MCP server catalog unavailable")
	errLLMModelCatalog  = errors.New("LLM model catalog unavailable")
)

type AgentHandler struct {
	agentRepo    agentStore
	validator    *agentConfigurationValidator
	dependencies resourceDependencyChecker
}

// agentConfigurationValidator owns validation shared by the standalone-agent
// and agent-team transports. It depends on domain-facing readers/registries,
// not on either HTTP handler, so neither product resource is coupled to the
// other's transport implementation.
type agentConfigurationValidator struct {
	agentRepo    agentReader
	toolRegistry *tools.ToolRegistry
	toolCatalog  toolDefinitionCatalog
	mcpCatalog   mcpServerLookup
	modelCatalog llmModelLookup
	providers    providerAvailability
}

func NewAgentHandler(
	agentRepo agentStore,
	toolRegistry *tools.ToolRegistry,
	toolCatalog toolDefinitionCatalog,
	mcpCatalog mcpServerLookup,
	modelCatalog llmModelLookup,
	providers providerAvailability,
	dependencies ...resourceDependencyChecker,
) *AgentHandler {
	handler := &AgentHandler{
		agentRepo: agentRepo,
		validator: &agentConfigurationValidator{
			agentRepo: agentRepo, toolRegistry: toolRegistry, toolCatalog: toolCatalog, mcpCatalog: mcpCatalog,
			modelCatalog: modelCatalog, providers: providers,
		},
	}
	if len(dependencies) > 0 {
		handler.dependencies = dependencies[0]
	}
	return handler
}

type CreateAgentRequest struct {
	Name               string                   `json:"name"`
	Description        string                   `json:"description"`
	Provider           string                   `json:"provider"`
	Model              string                   `json:"model"`
	SystemPrompt       string                   `json:"system_prompt"`
	Tools              []string                 `json:"tools"`
	Delegates          []DelegateConfigJSON     `json:"delegates"`
	MCPServers         []MCPServerSelectionJSON `json:"mcp_servers"`
	ContextWindow      *int                     `json:"context_window"`
	ContextKeepRatio   *float64                 `json:"context_keep_ratio"`
	SummarizationModel string                   `json:"summarization_model"`
	MaxSteps           *int                     `json:"max_steps"`
	Temperature        *float64                 `json:"temperature"`
	MaxTokens          *int                     `json:"max_tokens"`
	MaxRuns            *int                     `json:"max_runs"`
}

type UpdateAgentRequest struct {
	Name               *string                   `json:"name"`
	Description        *string                   `json:"description"`
	Provider           *string                   `json:"provider"`
	Model              *string                   `json:"model"`
	SystemPrompt       *string                   `json:"system_prompt"`
	Tools              *[]string                 `json:"tools"`
	Delegates          *[]DelegateConfigJSON     `json:"delegates"`
	MCPServers         *[]MCPServerSelectionJSON `json:"mcp_servers"`
	ContextWindow      *int                      `json:"context_window"`
	ContextKeepRatio   *float64                  `json:"context_keep_ratio"`
	SummarizationModel *string                   `json:"summarization_model"`
	MaxSteps           *int                      `json:"max_steps"`
	Temperature        *float64                  `json:"temperature"`
	MaxTokens          *int                      `json:"max_tokens"`
	MaxRuns            *int                      `json:"max_runs"`
}

type AgentResponse struct {
	ID                 string                   `json:"id"`
	Kind               string                   `json:"kind"`
	Name               string                   `json:"name"`
	Description        string                   `json:"description,omitempty"`
	Provider           string                   `json:"provider"`
	Model              string                   `json:"model"`
	SystemPrompt       string                   `json:"system_prompt"`
	Tools              []string                 `json:"tools"`
	MCPServers         []MCPServerSelectionJSON `json:"mcp_servers,omitempty"`
	ContextWindow      int                      `json:"context_window"`
	ContextKeepRatio   float64                  `json:"context_keep_ratio"`
	SummarizationModel string                   `json:"summarization_model,omitempty"`
	MaxSteps           int                      `json:"max_steps"`
	Temperature        float64                  `json:"temperature"`
	MaxTokens          int                      `json:"max_tokens"`
	MaxRuns            int                      `json:"max_runs"`
	CreatedAt          string                   `json:"created_at"`
	UpdatedAt          string                   `json:"updated_at"`
}

func toAgentResponse(a *agent.Agent) AgentResponse {
	return AgentResponse{
		ID:                 a.ID,
		Kind:               string(agent.EffectiveResourceKind(a)),
		Name:               a.Name,
		Description:        a.Description,
		Provider:           a.Provider,
		Model:              a.Model,
		SystemPrompt:       a.SystemPrompt,
		Tools:              a.Tools,
		MCPServers:         mcpServersToJSON(a.MCPServers),
		ContextWindow:      a.ContextWindow,
		ContextKeepRatio:   a.ContextKeepRatio,
		SummarizationModel: a.SummarizationModel,
		MaxSteps:           a.MaxSteps,
		Temperature:        a.Temperature,
		MaxTokens:          a.MaxTokens,
		MaxRuns:            resolveAgentMaxRuns(a.MaxRuns),
		CreatedAt:          a.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:          a.UpdatedAt.UTC().Format(time.RFC3339Nano),
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

func validateNonBlank(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", name)
	}
	return nil
}

func validateOptionalNonBlank(name string, value *string) error {
	if value == nil {
		return nil
	}
	return validateNonBlank(name, *value)
}

func trimmedStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

func validateAgentTuning(
	contextWindow *int,
	contextKeepRatio *float64,
	maxSteps *int,
	temperature *float64,
	maxTokens *int,
	maxRuns *int,
) error {
	integerSettings := []struct {
		name  string
		value *int
	}{
		{name: "context_window", value: contextWindow},
		{name: "max_steps", value: maxSteps},
		{name: "max_tokens", value: maxTokens},
		{name: "max_runs", value: maxRuns},
	}
	for _, setting := range integerSettings {
		if err := validatePositiveInt(setting.name, setting.value); err != nil {
			return err
		}
	}
	if contextKeepRatio != nil && (*contextKeepRatio <= 0 || *contextKeepRatio > 1) {
		return errors.New("context_keep_ratio must be greater than 0 and at most 1")
	}
	// A zero value currently means "use the AgentFlow default" in the runtime,
	// so accepting it as an explicit setting would misrepresent user intent.
	if temperature != nil && (*temperature <= 0 || *temperature > 1) {
		return errors.New("temperature must be greater than 0 and at most 1")
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

	requiredFields := []struct{ name, value string }{
		{name: "name", value: req.Name},
		{name: "provider", value: req.Provider},
		{name: "model", value: req.Model},
		{name: "system_prompt", value: req.SystemPrompt},
	}
	for _, field := range requiredFields {
		if err := validateNonBlank(field.name, field.value); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if err := validateAgentTuning(
		req.ContextWindow, req.ContextKeepRatio, req.MaxSteps,
		req.Temperature, req.MaxTokens, req.MaxRuns,
	); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.validator.validateModelSelection(
		r.Context(), req.Provider, req.Model, req.SummarizationModel,
	); err != nil {
		writeConfigurationValidationError(w, err)
		return
	}

	if req.Tools == nil {
		req.Tools = []string{}
	}
	if err := h.validator.validateTools(req.Tools); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Delegates) > 0 {
		writeError(w, http.StatusBadRequest, "delegates belong to an agent team")
		return
	}
	mcpServers := toMCPServerSelections(req.MCPServers)
	if err := h.validator.validateMCPServers(r.Context(), mcpServers); err != nil {
		writeMCPValidationError(w, err)
		return
	}

	a := &agent.Agent{
		Kind:               agent.ResourceKindStandaloneAgent,
		Name:               strings.TrimSpace(req.Name),
		Description:        req.Description,
		Provider:           strings.TrimSpace(req.Provider),
		Model:              strings.TrimSpace(req.Model),
		SystemPrompt:       req.SystemPrompt,
		Tools:              req.Tools,
		MCPServers:         mcpServers,
		SummarizationModel: strings.TrimSpace(req.SummarizationModel),
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

	resp := make([]AgentResponse, 0, len(agents))
	for _, a := range agents {
		if agent.EffectiveResourceKind(a) != agent.ResourceKindStandaloneAgent {
			continue
		}
		resp = append(resp, toAgentResponse(a))
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
	if agent.EffectiveResourceKind(a) != agent.ResourceKindStandaloneAgent {
		writeError(w, http.StatusNotFound, "agent not found")
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
	current, err := h.agentRepo.GetByID(r.Context(), agentID, userID)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent")
		return
	}
	if agent.EffectiveResourceKind(current) != agent.ResourceKindStandaloneAgent {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if req.Delegates != nil {
		writeError(w, http.StatusBadRequest, "delegates belong to an agent team")
		return
	}
	optionalFields := []struct {
		name  string
		value *string
	}{
		{name: "name", value: req.Name},
		{name: "provider", value: req.Provider},
		{name: "model", value: req.Model},
		{name: "system_prompt", value: req.SystemPrompt},
	}
	for _, field := range optionalFields {
		if err := validateOptionalNonBlank(field.name, field.value); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if err := validateAgentTuning(
		req.ContextWindow, req.ContextKeepRatio, req.MaxSteps,
		req.Temperature, req.MaxTokens, req.MaxRuns,
	); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Provider != nil || req.Model != nil || req.SummarizationModel != nil {
		provider, modelID, summarizationModel := current.Provider, current.Model, current.SummarizationModel
		if req.Provider != nil {
			provider = strings.TrimSpace(*req.Provider)
		}
		if req.Model != nil {
			modelID = strings.TrimSpace(*req.Model)
		}
		if req.SummarizationModel != nil {
			summarizationModel = strings.TrimSpace(*req.SummarizationModel)
		}
		if err := h.validator.validateModelSelection(r.Context(), provider, modelID, summarizationModel); err != nil {
			writeConfigurationValidationError(w, err)
			return
		}
	}
	input := agent.UpdateAgentInput{
		Name:               trimmedStringPointer(req.Name),
		Description:        req.Description,
		Provider:           trimmedStringPointer(req.Provider),
		Model:              trimmedStringPointer(req.Model),
		SystemPrompt:       req.SystemPrompt,
		Tools:              req.Tools,
		Temperature:        req.Temperature,
		MaxSteps:           req.MaxSteps,
		MaxTokens:          req.MaxTokens,
		MaxRuns:            req.MaxRuns,
		ContextWindow:      req.ContextWindow,
		ContextKeepRatio:   req.ContextKeepRatio,
		SummarizationModel: trimmedStringPointer(req.SummarizationModel),
	}
	if req.Tools != nil {
		if err := h.validator.validateTools(*req.Tools); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if req.MCPServers != nil {
		mcpServers := toMCPServerSelections(*req.MCPServers)
		if err := h.validator.validateMCPServers(r.Context(), mcpServers); err != nil {
			writeMCPValidationError(w, err)
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

	agentID := r.PathValue("id")
	current, err := h.agentRepo.GetByID(r.Context(), agentID, userID)
	if err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent")
		return
	}
	if agent.EffectiveResourceKind(current) != agent.ResourceKindStandaloneAgent {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if !h.canDelete(w, r, userID, agentID) {
		return
	}

	if err := h.agentRepo.Delete(r.Context(), agentID, userID); err != nil {
		if err.Error() == "agent not found" {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete agent")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "agent deleted"})
}

func (h *AgentHandler) canDelete(w http.ResponseWriter, r *http.Request, userID, resourceID string) bool {
	if h.dependencies == nil {
		return true
	}
	dependencies, err := h.dependencies.BlockingDependencies(r.Context(), userID, resourceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to verify resource dependencies")
		return false
	}
	if len(dependencies) == 0 {
		return true
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":        "resource cannot be deleted while it has dependencies",
		"dependencies": dependencies,
	})
	return false
}

func (v *agentConfigurationValidator) validateTools(toolNames []string) error {
	seen := make(map[string]bool, len(toolNames))
	for _, name := range toolNames {
		if !v.toolRegistry.Has(name) {
			return errors.New("unknown or unavailable tool: " + name)
		}
		if seen[name] {
			return errors.New("duplicate tool: " + name)
		}
		seen[name] = true
	}
	return nil
}

func (v *agentConfigurationValidator) validateModelSelection(
	ctx context.Context,
	provider string,
	modelID string,
	summarizationModel string,
) error {
	provider = strings.TrimSpace(provider)
	modelID = strings.TrimSpace(modelID)
	summarizationModel = strings.TrimSpace(summarizationModel)

	providerAvailable := false
	if v.providers != nil {
		for _, available := range v.providers.Available() {
			if available == provider {
				providerAvailable = true
				break
			}
		}
	}
	if !providerAvailable {
		return fmt.Errorf("provider %q is unavailable", provider)
	}
	if v.modelCatalog == nil {
		return errLLMModelCatalog
	}
	exists, err := v.modelCatalog.Exists(ctx, provider, modelID)
	if err != nil {
		return fmt.Errorf("%w: %v", errLLMModelCatalog, err)
	}
	if !exists {
		return fmt.Errorf("unknown model %q for provider %q", modelID, provider)
	}
	if summarizationModel == "" {
		return nil
	}
	exists, err = v.modelCatalog.Exists(ctx, provider, summarizationModel)
	if err != nil {
		return fmt.Errorf("%w: %v", errLLMModelCatalog, err)
	}
	if !exists {
		return fmt.Errorf("unknown summarization_model %q for provider %q", summarizationModel, provider)
	}
	return nil
}

func toMCPServerSelections(in []MCPServerSelectionJSON) []agent.MCPServerSelection {
	if len(in) == 0 {
		return nil
	}
	out := make([]agent.MCPServerSelection, len(in))
	for i, m := range in {
		out[i] = agent.MCPServerSelection{ServerID: m.ServerID}
	}
	return out
}

func mcpServersToJSON(in []agent.MCPServerSelection) []MCPServerSelectionJSON {
	if len(in) == 0 {
		return nil
	}
	out := make([]MCPServerSelectionJSON, len(in))
	for i, m := range in {
		out[i] = MCPServerSelectionJSON{ServerID: m.ServerID}
	}
	return out
}

func (v *agentConfigurationValidator) validateMCPServers(ctx context.Context, servers []agent.MCPServerSelection) error {
	if len(servers) == 0 {
		return nil
	}
	serverIDs := make([]string, len(servers))
	seen := make(map[string]struct{}, len(servers))
	for _, s := range servers {
		if err := mcp.ValidateServerID(s.ServerID); err != nil {
			return err
		}
		if _, exists := seen[s.ServerID]; exists {
			return fmt.Errorf("duplicate MCP server_id %q", s.ServerID)
		}
		seen[s.ServerID] = struct{}{}
	}
	for i, server := range servers {
		serverIDs[i] = server.ServerID
	}
	if v.mcpCatalog == nil {
		return errMCPServerCatalog
	}
	entries, err := v.mcpCatalog.GetEnabledByIDs(ctx, serverIDs)
	if err != nil {
		return fmt.Errorf("%w: %v", errMCPServerCatalog, err)
	}
	seenAliases := make(map[string]struct{}, len(serverIDs))
	for _, serverID := range serverIDs {
		entry, exists := entries[serverID]
		if !exists {
			return fmt.Errorf("unknown or disabled MCP server %q", serverID)
		}
		if entry.ServerID != serverID {
			return fmt.Errorf("%w: mismatched server_id", errMCPServerCatalog)
		}
		if err := mcp.ValidateCatalogIdentity(entry); err != nil {
			return fmt.Errorf("%w: invalid entry for %q", errMCPServerCatalog, serverID)
		}
		if _, exists := seenAliases[entry.Alias]; exists {
			return fmt.Errorf("%w: duplicate alias", errMCPServerCatalog)
		}
		seenAliases[entry.Alias] = struct{}{}
	}
	return nil
}

func writeMCPValidationError(w http.ResponseWriter, err error) {
	if errors.Is(err, errMCPServerCatalog) {
		writeError(w, http.StatusInternalServerError, "failed to validate MCP servers")
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}

func writeConfigurationValidationError(w http.ResponseWriter, err error) {
	if errors.Is(err, errLLMModelCatalog) {
		writeError(w, http.StatusInternalServerError, "failed to validate LLM model")
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}

// validateDelegates enforces provider-safe tool names, no collisions (against
// tools, other delegates, or any registered tool), same-user ownership of the
// target, and (on update) no self-delegate.
func (v *agentConfigurationValidator) validateDelegates(ctx context.Context, userID, thisAgentID string, toolNames []string, delegates []agent.DelegateConfig) error {
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
		if v.isCatalogTool(d.ToolName) {
			return fmt.Errorf("delegate tool_name %q collides with a registered tool", d.ToolName)
		}
		seen[d.ToolName] = true
		if thisAgentID != "" && d.AgentID == thisAgentID {
			return errors.New("an agent cannot delegate to itself")
		}
		member, err := v.agentRepo.GetByID(ctx, d.AgentID, userID)
		if err != nil {
			return fmt.Errorf("delegate agent %s not found or not owned", d.AgentID)
		}
		if agent.EffectiveResourceKind(member) != agent.ResourceKindStandaloneAgent {
			return fmt.Errorf("delegate agent %s must be a standalone agent", d.AgentID)
		}
	}
	return nil
}

func (v *agentConfigurationValidator) isCatalogTool(name string) bool {
	if v.toolCatalog == nil {
		return v.toolRegistry.Has(name)
	}
	for _, definition := range v.toolCatalog.Definitions() {
		if definition.Name == name {
			return true
		}
	}
	return false
}
