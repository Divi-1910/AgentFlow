package handlers

import (
	"context"
	"errors"
	"net/http"
	"time"

	"backend/agent"
	"backend/repository"
	"backend/tools"
)

// agentStore is the subset of repository.AgentRepo used by handlers.
type agentStore interface {
	Create(ctx context.Context, userID string, a *agent.Agent) (*agent.Agent, error)
	GetByID(ctx context.Context, agentID, userID string) (*agent.Agent, error)
	GetByIDSystem(ctx context.Context, agentID string) (*agent.Agent, error)
	ListByUser(ctx context.Context, userID string) ([]*agent.Agent, error)
	Update(ctx context.Context, agentID, userID string, input repository.UpdateAgentInput) (*agent.Agent, error)
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
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	Provider           string   `json:"provider"`
	Model              string   `json:"model"`
	SystemPrompt       string   `json:"system_prompt"`
	Tools              []string `json:"tools"`
	ContextWindow      *int     `json:"context_window"`
	ContextKeepRatio   *float64 `json:"context_keep_ratio"`
	SummarizationModel string   `json:"summarization_model"`
	MaxSteps           *int     `json:"max_steps"`
	Temperature        *float64 `json:"temperature"`
	MaxTokens          *int     `json:"max_tokens"`
}

type UpdateAgentRequest struct {
	Name               *string   `json:"name"`
	Description        *string   `json:"description"`
	Provider           *string   `json:"provider"`
	Model              *string   `json:"model"`
	SystemPrompt       *string   `json:"system_prompt"`
	Tools              *[]string `json:"tools"`
	ContextKeepRatio   *float64  `json:"context_keep_ratio"`
	SummarizationModel *string   `json:"summarization_model"`
	MaxSteps           *int      `json:"max_steps"`
	Temperature        *float64  `json:"temperature"`
	MaxTokens          *int      `json:"max_tokens"`
}

type AgentResponse struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Description        string   `json:"description,omitempty"`
	Provider           string   `json:"provider"`
	Model              string   `json:"model"`
	SystemPrompt       string   `json:"system_prompt"`
	Tools              []string `json:"tools"`
	ContextWindow      int      `json:"context_window"`
	ContextKeepRatio   float64  `json:"context_keep_ratio"`
	SummarizationModel string   `json:"summarization_model,omitempty"`
	MaxSteps           int      `json:"max_steps"`
	Temperature        float64  `json:"temperature"`
	MaxTokens          int      `json:"max_tokens"`
	CreatedAt          string   `json:"created_at"`
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
		ContextWindow:      a.ContextWindow,
		ContextKeepRatio:   a.ContextKeepRatio,
		SummarizationModel: a.SummarizationModel,
		MaxSteps:           a.MaxSteps,
		Temperature:        a.Temperature,
		MaxTokens:          a.MaxTokens,
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

	a := &agent.Agent{
		Name:               req.Name,
		Description:        req.Description,
		Provider:           req.Provider,
		Model:              req.Model,
		SystemPrompt:       req.SystemPrompt,
		Tools:              req.Tools,
		SummarizationModel: req.SummarizationModel,
		MaxSteps:           resolveInt(req.MaxSteps, agent.DefaultMaxSteps),
		MaxTokens:          resolveInt(req.MaxTokens, agent.DefaultMaxTokens),
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

	input := repository.UpdateAgentInput{
		Name:               req.Name,
		Description:        req.Description,
		Provider:           req.Provider,
		Model:              req.Model,
		SystemPrompt:       req.SystemPrompt,
		Tools:              req.Tools,
		Temperature:        req.Temperature,
		MaxSteps:           req.MaxSteps,
		MaxTokens:          req.MaxTokens,
		ContextKeepRatio:   req.ContextKeepRatio,
		SummarizationModel: req.SummarizationModel,
	}
	if req.Tools != nil {
		if err := h.validateTools(*req.Tools); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	updated, err := h.agentRepo.Update(r.Context(), r.PathValue("id"), userID, input)
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
	for _, name := range toolNames {
		if !h.toolRegistry.Has(name) {
			return errors.New("unknown tool: " + name)
		}
	}
	return nil
}
