package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/deployment"
	"backend/dispatcher"
	"backend/handlers"
	"backend/llm"
	"backend/memory"
	"backend/middleware"
	"backend/repo/sqliterepo"
	"backend/scratchpad"
	"backend/tools"
)

const maxRequestBodyBytes = 1 << 20

type appConfig struct {
	bundle         *deployment.Bundle
	dataDir        string
	listenAddr     string
	auth           authConfig
	logger         *slog.Logger
	providers      *llm.LLMRegistry
	mcpManager     *tools.MCPManager
	lookupEnv      func(string) (string, bool)
	validateMCPURL func(string) error
}

type runtimeApp struct {
	server          *http.Server
	db              *sql.DB
	bus             *bus.InProcBus
	pools           *dispatcher.PoolManager
	cancelRuntime   context.CancelFunc
	coordinatorDone chan struct{}
	ready           atomic.Bool
	closeOnce       sync.Once
}

func newRuntimeApp(parent context.Context, cfg appConfig) (_ *runtimeApp, err error) {
	if cfg.bundle == nil {
		return nil, fmt.Errorf("runtime: deployment bundle is required")
	}
	if cfg.dataDir == "" {
		return nil, fmt.Errorf("runtime: data directory is required")
	}
	if cfg.listenAddr == "" {
		cfg.listenAddr = ":9090"
	}
	if cfg.logger == nil {
		cfg.logger = slog.Default()
	}
	if err := cfg.bundle.ValidateStatic(); err != nil {
		return nil, err
	}
	if err := cfg.bundle.VerifyHash(); err != nil {
		return nil, err
	}
	if err := cfg.bundle.ValidateEnvironmentWith(cfg.lookupEnv, cfg.validateMCPURL); err != nil {
		return nil, err
	}
	providers := cfg.providers
	if providers == nil {
		providers = llm.NewLLMRegistry()
	}
	capabilities := agent.ToolCapabilities{AsyncJobs: true}
	if err := cfg.bundle.ValidateRuntime(tools.NewValidationRegistry(), providers, capabilities); err != nil {
		return nil, err
	}

	// All deterministic bundle, environment, provider, and tool validation is
	// complete before this first filesystem mutation.
	if err := os.MkdirAll(cfg.dataDir, 0o750); err != nil {
		return nil, fmt.Errorf("runtime: create data directory: %w", err)
	}

	database, err := sqliterepo.Open(filepath.Join(cfg.dataDir, "state.db"), sqliterepo.Options{})
	if err != nil {
		return nil, err
	}
	app := &runtimeApp{db: database}
	defer func() {
		if err != nil {
			_ = app.closeResources(context.Background())
		}
	}()

	userID := cfg.bundle.SyntheticUserID()
	identityRepo := sqliterepo.NewDeploymentIdentityRepo(database)
	if err = identityRepo.Bind(parent, sqliterepo.DeploymentBinding{
		DeploymentID: cfg.bundle.DeploymentID, ConfigHash: cfg.bundle.ConfigHash, SyntheticUserID: userID,
	}); err != nil {
		return nil, err
	}

	runRepo := sqliterepo.NewRunRepo(database)
	recovery, err := runRepo.RecoverOrphanedRuns(parent, userID)
	if err != nil {
		return nil, err
	}
	if recovery.Interrupted > 0 || recovery.Failed > 0 {
		cfg.logger.Info("recovered orphaned runs", "interrupted", recovery.Interrupted, "failed", recovery.Failed)
	}
	threadRepo := sqliterepo.NewThreadRepo(database)
	messageRepo := sqliterepo.NewMessageRepo(database)
	taskRepo := sqliterepo.NewTaskRepo(database)
	jobRepo := sqliterepo.NewJobRepo(database)
	jobRepo.SetTaskBudgetStore(taskRepo)
	memoryMetaRepo := sqliterepo.NewMemoryMetaRepo(database)
	memoryRevisionRepo := sqliterepo.NewMemoryRevisionRepo(database)

	runtimeCtx, cancelRuntime := context.WithCancel(parent)
	app.cancelRuntime = cancelRuntime
	memorySvc := memory.NewService(memory.Config{
		Root: filepath.Join(cfg.dataDir, "memory"), RGPath: os.Getenv("RG_PATH"),
	}, memoryMetaRepo, memoryRevisionRepo)
	if err = memorySvc.ValidateStartup(); err != nil {
		return nil, err
	}
	memorySvc.StartCleanupWorker(runtimeCtx, 7*24*time.Hour)
	scratchpadSvc := scratchpad.NewService(scratchpad.Config{
		Root: filepath.Join(cfg.dataDir, "scratchpad"), RGPath: os.Getenv("RG_PATH"),
	})
	if err = scratchpadSvc.ValidateStartup(); err != nil {
		return nil, err
	}

	toolRegistry := tools.NewToolRegistry(nil, memorySvc, scratchpadSvc)
	agentReader := deployment.NewAgentReader(cfg.bundle, userID)
	contextBuilder := agent.NewContextBuilder(&agent.PlatformConfig{Body: cfg.bundle.PlatformXML}, memorySvc, memoryMetaRepo, scratchpadSvc)
	agentRuntime := agent.NewAgentRuntime(providers, toolRegistry, contextBuilder, capabilities).WithCheckpointStore(runRepo)
	mcpManager := cfg.mcpManager
	if mcpManager == nil {
		mcpManager = tools.NewMCPManager(&http.Client{Timeout: 60 * time.Second})
	}
	agentRuntime.SetMCPManager(mcpManager)
	agentRuntime.SetAsyncJobStore(jobRepo)
	summarizer := agent.NewSummarizer(providers)

	theBus := bus.NewInProc()
	app.bus = theBus
	jobHub := dispatcher.NewJobHub()
	preparer := dispatcher.NewRunPreparer(dispatcher.RunPreparerConfig{
		Agents: agentReader, Threads: threadRepo, Messages: messageRepo, Runs: runRepo,
		Summarizer: summarizer, Runtime: agentRuntime, ToolRegistry: toolRegistry,
		Tasks: taskRepo, Background: runtimeCtx, Capabilities: capabilities,
	})
	pools := dispatcher.NewPoolManager(dispatcher.PoolManagerConfig{
		RootCtx: runtimeCtx, Bus: theBus, Preparer: preparer, Runtime: agentRuntime,
		Status: runRepo, Messages: messageRepo, Jobs: jobRepo, Tasks: taskRepo, Hub: jobHub, Workers: 4,
	})
	app.pools = pools
	invoker := dispatcher.NewBusDelegateInvoker(dispatcher.BusDelegateInvokerConfig{
		Bus: theBus, Pools: pools, Agents: agentReader, Threads: threadRepo,
		Runs: runRepo, Messages: messageRepo, Tasks: taskRepo,
	})
	agentRuntime.SetDelegateInvoker(invoker)
	coordinator := dispatcher.NewJobCoordinator(dispatcher.JobCoordinatorConfig{
		Bus: theBus, Pools: pools, Threads: threadRepo, Runs: runRepo,
		Jobs: jobRepo, Tasks: taskRepo, Hub: jobHub, Logger: cfg.logger,
	})
	app.coordinatorDone = make(chan struct{})
	go func() {
		defer close(app.coordinatorDone)
		coordinator.Run(runtimeCtx)
	}()
	disp := &dispatcher.BusDispatcher{
		Bus: theBus, Pools: pools, Preparer: preparer, RequestTimeout: 30 * time.Minute,
	}

	threadHandler := handlers.NewThreadHandler(threadRepo, agentReader)
	messageHandler := handlers.NewMessageHandler(agentReader, threadRepo, messageRepo, disp, runRepo)
	runHandler := handlers.NewRunHandler(agentReader, messageRepo, runRepo, disp, toolRegistry, capabilities)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", app.health)
	mux.HandleFunc("GET /readyz", app.readiness)
	protected := http.NewServeMux()
	protected.HandleFunc("POST /v1/threads", threadHandler.CreateForAgent(cfg.bundle.RootAgentID))
	protected.HandleFunc("POST /v1/threads/{id}/messages", messageHandler.Send)
	protected.HandleFunc("GET /v1/threads/{id}/messages", messageHandler.List)
	protected.HandleFunc("GET /v1/runs/{id}", runHandler.GetRun)
	protected.HandleFunc("POST /v1/runs/{id}/resume", runHandler.ResumeRun)
	mux.Handle("/v1/", cfg.auth.middleware(userID, protected))

	app.server = &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           middleware.RequestID(loggingMiddleware(cfg.logger)(middleware.BodyLimit(maxRequestBodyBytes)(mux))),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	app.ready.Store(true)
	return app, nil
}

func (a *runtimeApp) Serve() error {
	err := a.server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (a *runtimeApp) Shutdown(ctx context.Context) error {
	a.ready.Store(false)
	shutdownErr := a.server.Shutdown(ctx)
	if shutdownErr != nil {
		_ = a.server.Close()
	}
	// Runtime cancellation is local and deterministic; give the coordinator a
	// fresh window even when the HTTP drain context has already expired.
	resourceCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resourceErr := a.closeResources(resourceCtx)
	return errors.Join(shutdownErr, resourceErr)
}

func (a *runtimeApp) closeResources(ctx context.Context) error {
	var closeErr error
	a.closeOnce.Do(func() {
		if a.cancelRuntime != nil {
			a.cancelRuntime()
		}
		if a.coordinatorDone != nil {
			select {
			case <-a.coordinatorDone:
			case <-ctx.Done():
				closeErr = errors.Join(closeErr, ctx.Err())
			}
		}
		if a.pools != nil {
			a.pools.StopAll()
		}
		if a.bus != nil {
			closeErr = errors.Join(closeErr, a.bus.Close())
		}
		if a.db != nil {
			closeErr = errors.Join(closeErr, a.db.Close())
		}
	})
	return closeErr
}

func (a *runtimeApp) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *runtimeApp) readiness(w http.ResponseWriter, r *http.Request) {
	if !a.ready.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if err := a.db.PingContext(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func loggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			logger.Info("request", "method", r.Method, "path", r.URL.Path)
			next.ServeHTTP(w, r)
			logger.Info("request completed", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(start).Milliseconds())
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
