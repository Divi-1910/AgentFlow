package dispatcher

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"backend/agent"
	"backend/mcp"
	"backend/runtimectx"
	"backend/tools"
)

type RunPreparerConfig struct {
	Agents       AgentReader
	Threads      ThreadStore
	Messages     MessageStore
	Runs         agent.CheckpointStore
	Summarizer   Summarizer
	Runtime      Runtime
	ToolRegistry *tools.ToolRegistry
	MCPServers   MCPServerCatalog
	Tasks        taskBudgetStore
	Background   context.Context
	Capabilities agent.ToolCapabilities
}

type MCPServerCatalog interface {
	GetEnabledByIDs(ctx context.Context, serverIDs []string) (map[string]mcp.CatalogEntry, error)
}

type RunPreparer struct {
	agents       AgentReader
	threads      ThreadStore
	messages     MessageStore
	runs         agent.CheckpointStore
	summarizer   Summarizer
	runtime      Runtime
	toolRegistry *tools.ToolRegistry
	mcpServers   MCPServerCatalog
	tasks        taskBudgetStore
	background   context.Context
	capabilities agent.ToolCapabilities

	summarizing sync.Map
}

type PreparedRun struct {
	Agent  *agent.Agent
	RunCtx agent.RunContext
}

func NewRunPreparer(cfg RunPreparerConfig) *RunPreparer {
	background := cfg.Background
	if background == nil {
		background = context.Background()
	}
	return &RunPreparer{
		agents:       cfg.Agents,
		threads:      cfg.Threads,
		messages:     cfg.Messages,
		runs:         cfg.Runs,
		summarizer:   cfg.Summarizer,
		runtime:      cfg.Runtime,
		toolRegistry: cfg.ToolRegistry,
		mcpServers:   cfg.MCPServers,
		tasks:        cfg.Tasks,
		background:   background,
		capabilities: cfg.Capabilities,
	}
}

func (p *RunPreparer) Prepare(ctx context.Context, req DispatchRequest) (PreparedRun, error) {
	if req.IsResume {
		return p.prepareResume(ctx, req)
	}
	return p.prepareFresh(ctx, req)
}

func (p *RunPreparer) EstimateSystemPromptTokens(ctx context.Context, req EstimateRequest) int {
	if p == nil || p.runtime == nil || p.agents == nil {
		return 0
	}
	ag, err := p.agents.GetByID(ctx, req.AgentID, req.UserID)
	if err != nil {
		return 0
	}
	ag, err = p.resolveMCPConnections(ctx, ag)
	if err != nil {
		return 0
	}
	runCtx := agent.RunContext{
		ThreadID: req.ThreadID,
		Summary:  req.Summary,
		Memory: runtimectx.MemoryScope{
			UserID:   req.UserID,
			AgentID:  ag.ID,
			ThreadID: req.ThreadID,
		},
	}
	return p.runtime.EstimateSystemPromptTokens(ctx, ag, runCtx)
}

func (p *RunPreparer) prepareFresh(ctx context.Context, req DispatchRequest) (PreparedRun, error) {
	if p.agents == nil || p.threads == nil || p.messages == nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: run preparer is not configured")
	}

	thread, err := p.threads.GetByID(ctx, req.ThreadID, req.UserID)
	if err != nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: load thread: %w", err)
	}
	threadAgentID := thread.AgentID
	if req.AgentID != "" && req.AgentID != threadAgentID {
		return PreparedRun{}, fmt.Errorf("dispatcher: request agent %s does not own thread %s", req.AgentID, req.ThreadID)
	}

	ag, err := p.agents.GetByID(ctx, threadAgentID, req.UserID)
	if err != nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: load agent: %w", err)
	}
	ag, err = p.resolveMCPConnections(ctx, ag)
	if err != nil {
		return PreparedRun{}, err
	}

	rawMessages, err := p.messages.ListRecentByThread(ctx, req.ThreadID, 500)
	if err != nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: load history: %w", err)
	}

	turns := agent.GroupIntoTurns(rawMessages)
	currentSummary := thread.Summary
	estimateRunCtx := agent.RunContext{
		ThreadID: req.ThreadID,
		Summary:  currentSummary,
		Memory: runtimectx.MemoryScope{
			UserID:   req.UserID,
			AgentID:  ag.ID,
			ThreadID: req.ThreadID,
		},
	}

	sysTokens := 0
	if p.runtime != nil {
		sysTokens = p.runtime.EstimateSystemPromptTokens(ctx, ag, estimateRunCtx)
	}
	var (
		shouldCompact bool
		drop, keep    []agent.Turn
	)
	if sysTokens > 0 {
		shouldCompact = agent.ShouldSummarizeWithSysTokens(ag, sysTokens, turns)
	} else {
		shouldCompact = agent.ShouldSummarize(ag, currentSummary, turns)
	}

	if shouldCompact {
		if sysTokens > 0 {
			drop, keep = agent.SplitTurnsForCompactionWithSysTokens(ag, sysTokens, turns)
		} else {
			drop, keep = agent.SplitTurnsForCompaction(ag, currentSummary, turns)
		}

		if len(drop) > 0 {
			turns = keep
			p.kickSummarization(req.ThreadID, req.UserID, ag, currentSummary, drop)
		}
	}

	logger := req.Logger
	if logger == nil {
		logger = slog.With("run_id", req.RunID, "thread_id", req.ThreadID, "user_id", req.UserID)
	}

	// Delegation lineage: a child run carries these in req; a top-level run
	// defaults to originator=self, chain=[agent], depth=0.
	originator := req.OriginatorRunID
	if originator == "" {
		originator = req.RunID
	}
	chain := req.Chain
	if len(chain) == 0 {
		chain = []string{ag.ID}
	}
	invocationKind := req.InvocationKind
	if invocationKind == "" {
		if req.ParentRunID != "" {
			invocationKind = agent.InvocationSyncDelegate
		} else {
			invocationKind = agent.InvocationTopLevel
		}
	}
	if invocationKind == agent.InvocationTopLevel && p.tasks != nil {
		if err := p.tasks.EnsureTask(ctx, originator, req.UserID, ag.MaxRuns); err != nil {
			return PreparedRun{}, fmt.Errorf("dispatcher: ensure task budget: %w", err)
		}
	}

	return PreparedRun{
		Agent: ag,
		RunCtx: agent.RunContext{
			RunID:         req.RunID,
			ThreadID:      req.ThreadID,
			Attempt:       1,
			Summary:       currentSummary,
			History:       agent.FlattenTurns(turns),
			Input:         req.Input,
			SystemContext: req.SystemContext,
			Memory: runtimectx.MemoryScope{
				UserID:   req.UserID,
				AgentID:  ag.ID,
				ThreadID: req.ThreadID,
			},
			Logger:          logger,
			OriginatorRunID: originator,
			ParentRunID:     req.ParentRunID,
			DelegationChain: chain,
			DelegationDepth: req.Depth,
			InvocationKind:  invocationKind,
			JobID:           req.JobID,
		},
	}, nil
}

func (p *RunPreparer) prepareResume(ctx context.Context, req DispatchRequest) (PreparedRun, error) {
	if p.agents == nil || p.runs == nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: run preparer is not configured")
	}

	snapshot, err := p.runs.LoadLatest(ctx, req.RunID)
	if err != nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: load checkpoint: %w", err)
	}

	// Load the agent first so the effective tool set (delegates included) can
	// be built for validation.
	ag, err := p.agents.GetByIDSystem(ctx, snapshot.Meta.AgentID)
	if err != nil {
		return PreparedRun{}, fmt.Errorf("dispatcher: load agent for resume: %w", err)
	}
	ag, err = p.resolveMCPConnections(ctx, ag)
	if err != nil {
		return PreparedRun{}, err
	}

	if p.toolRegistry != nil {
		toolSet, err := agent.BuildToolSetForValidation(p.toolRegistry, ag, p.capabilities)
		if err != nil {
			return PreparedRun{}, fmt.Errorf("dispatcher: build tool set for resume: %w", err)
		}
		if err := agent.ValidateSnapshot(snapshot, toolSet); err != nil {
			return PreparedRun{}, fmt.Errorf("dispatcher: validate checkpoint: %w", err)
		}
		if warning := agent.ToolsetCosmeticWarning(snapshot.Meta, toolSet); warning != "" {
			logger := req.Logger
			if logger == nil {
				logger = slog.Default()
			}
			logger.Warn("toolset cosmetic drift", "warning", warning)
		}
	}

	attempt := req.Attempt
	if attempt <= 0 {
		attempt = snapshot.Meta.Attempt + 1
	}
	snapshot.Meta.Attempt = attempt

	logger := req.Logger
	if logger == nil {
		logger = slog.With("run_id", req.RunID, "thread_id", snapshot.Meta.ThreadID, "user_id", req.UserID)
	}

	return PreparedRun{
		Agent: ag,
		RunCtx: agent.RunContext{
			RunID:      req.RunID,
			ThreadID:   snapshot.Meta.ThreadID,
			Attempt:    attempt,
			Checkpoint: snapshot,
			Summary:    snapshot.State.RawSummary,
			Memory: runtimectx.MemoryScope{
				UserID:   req.UserID,
				AgentID:  snapshot.Meta.AgentID,
				ThreadID: snapshot.Meta.ThreadID,
			},
			Logger:          logger,
			OriginatorRunID: snapshot.Meta.OriginatorRunID,
			ParentRunID:     snapshot.Meta.ParentRunID,
			DelegationChain: snapshot.Meta.DelegationChain,
			DelegationDepth: snapshot.Meta.DelegationDepth,
			InvocationKind:  snapshot.Meta.InvocationKind,
			JobID:           snapshot.Meta.JobID,
			SystemContext:   snapshot.Meta.SystemContext,
		},
	}, nil
}

func (p *RunPreparer) resolveMCPConnections(ctx context.Context, ag *agent.Agent) (*agent.Agent, error) {
	if p.mcpServers == nil {
		return ag, nil
	}
	copy := *ag
	copy.Tools = append([]string(nil), ag.Tools...)
	copy.Delegates = append([]agent.DelegateConfig(nil), ag.Delegates...)
	copy.MCPServers = append([]agent.MCPServerSelection(nil), ag.MCPServers...)
	copy.MCPConnections = nil
	if len(copy.MCPServers) == 0 {
		return &copy, nil
	}

	serverIDs := make([]string, len(copy.MCPServers))
	for i, selection := range copy.MCPServers {
		serverIDs[i] = selection.ServerID
	}
	entries, err := p.mcpServers.GetEnabledByIDs(ctx, serverIDs)
	if err != nil {
		return nil, fmt.Errorf("dispatcher: resolve MCP catalog: %w", err)
	}
	copy.MCPConnections = make([]agent.MCPServerConnection, len(copy.MCPServers))
	for i, selection := range copy.MCPServers {
		entry, exists := entries[selection.ServerID]
		if !exists {
			return nil, fmt.Errorf("dispatcher: unknown or disabled MCP server %q", selection.ServerID)
		}
		if entry.ServerID != selection.ServerID {
			return nil, fmt.Errorf("dispatcher: MCP catalog returned mismatched server_id %q for %q", entry.ServerID, selection.ServerID)
		}
		if err := mcp.ValidateCatalogIdentity(entry); err != nil {
			return nil, fmt.Errorf("dispatcher: invalid MCP catalog entry %q: %w", selection.ServerID, err)
		}
		if err := tools.ValidateManagedMCPServerURL(entry.StudioURL); err != nil {
			return nil, fmt.Errorf("dispatcher: invalid Studio URL for MCP server %q: %w", selection.ServerID, err)
		}
		copy.MCPConnections[i] = agent.MCPServerConnection{
			ServerID: entry.ServerID, Alias: entry.Alias, URL: entry.StudioURL,
		}
	}
	return &copy, nil
}

func (p *RunPreparer) kickSummarization(threadID, userID string, ag *agent.Agent, currentSummary string, drop []agent.Turn) {
	if p.summarizer == nil || p.threads == nil {
		return
	}

	bgLogger := slog.With("thread_id", threadID)
	if _, alreadyRunning := p.summarizing.LoadOrStore(threadID, struct{}{}); alreadyRunning {
		bgLogger.Info("bg summarization skipped, already in flight")
		return
	}

	go func() {
		defer p.summarizing.Delete(threadID)
		defer func() {
			if rec := recover(); rec != nil {
				bgLogger.Error("bg summarization panic", "error", rec)
			}
		}()

		compactCtx, cancel := context.WithTimeout(p.background, 30*time.Second)
		defer cancel()

		newSummary, _, err := p.summarizer.Summarize(compactCtx, ag, currentSummary, drop)
		if err != nil {
			bgLogger.Error("bg summarization failed", "error", err)
			return
		}
		if updateErr := p.threads.UpdateSummary(compactCtx, threadID, userID, newSummary); updateErr != nil {
			bgLogger.Error("bg summarization persist failed", "error", updateErr)
		}
	}()
}
