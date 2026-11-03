package main

import (
	"backend/agent"
	"backend/bus"
	"backend/db"
	"backend/deployment"
	"backend/deployment/delivery"
	deploymentkubernetes "backend/deployment/kubernetes"
	"backend/deployment/reconciler"
	"backend/dispatcher"
	"backend/handlers"
	"backend/llm"
	"backend/memory"
	"backend/middleware"
	"backend/publisher"
	"backend/repo/mongorepo"
	"backend/scratchpad"
	"backend/tools"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	kubeclient "k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:5173")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, PATCH, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, Idempotency-Key")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		logger := middleware.LoggerFromContext(r.Context())
		logger.Info("request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
		logger.Info("request completed", "method", r.Method, "path", r.URL.Path,
			"duration_ms", time.Since(start).Milliseconds())
	})
}

func main() {
	if err := godotenv.Load(); err != nil {
		slog.Info("no .env file found, using system environment variables")
	}

	appCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	managedDeployments, err := loadManagedDeploymentConfig(os.Getenv, os.Hostname)
	if err != nil {
		slog.Error("invalid managed deployment configuration", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}

		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "AgentFlow backend is running",
		})
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"status": "ok",
		})
	})

	const dbName = "AgentFlow"

	usersCol := db.GetCollection(dbName, "users")
	llmRegistryCol := db.GetCollection(dbName, "llm_registry")
	agentsCol := db.GetCollection(dbName, "agents")
	mcpServersCol := db.GetCollection(dbName, "mcp_servers")
	deploymentRevisionsCol := db.GetCollection(dbName, "deployment_revisions")
	deploymentStatesCol := db.GetCollection(dbName, "deployment_states")
	deploymentDeliveryTokensCol := db.GetCollection(dbName, "deployment_delivery_tokens")
	threadsCol := db.GetCollection(dbName, "threads")
	messagesCol := db.GetCollection(dbName, "messages")
	runsCol := db.GetCollection(dbName, "runs")
	checkpointsCol := db.GetCollection(dbName, "run_checkpoints")
	jobsCol := db.GetCollection(dbName, "jobs")
	jobLocksCol := db.GetCollection(dbName, "job_locks")
	tasksCol := db.GetCollection(dbName, "tasks")

	userRepo := mongorepo.NewUserRepo(usersCol)
	authHandler := handlers.NewAuthHandler(userRepo, nil) // nil → defaults to auth.GenerateToken

	llmRegistry := llm.NewLLMRegistry()

	memoryMetaCol := db.GetCollection(dbName, "memory_meta")
	memoryRevisionCol := db.GetCollection(dbName, "memory_revisions")
	memoryMetaRepo := mongorepo.NewMemoryMetaRepo(memoryMetaCol)
	if err := memoryMetaRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create memory meta indexes", "error", err)
		os.Exit(1)
	}
	memoryRevisionRepo := mongorepo.NewMemoryRevisionRepo(memoryRevisionCol)
	if err := memoryRevisionRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create memory revision indexes", "error", err)
		os.Exit(1)
	}

	memorySvc, err := memory.NewServiceFromEnv(memoryMetaRepo, memoryRevisionRepo)
	if err != nil {
		slog.Error("failed to initialize memory service", "error", err)
		os.Exit(1)
	}
	memorySvc.StartCleanupWorker(appCtx, 7*24*time.Hour)

	scratchpadSvc, err := scratchpad.NewServiceFromEnv()
	if err != nil {
		slog.Error("failed to initialize scratchpad service", "error", err)
		os.Exit(1)
	}

	toolRegistry := tools.NewToolRegistry(db.GetRedis(), memorySvc, scratchpadSvc)
	toolCatalog := tools.NewCatalogRegistry()
	mcpManager := tools.NewMCPManager(&http.Client{Timeout: 60 * time.Second})

	llmModelRepo := mongorepo.NewLLMModelRepo(llmRegistryCol)
	llmHandler := handlers.NewLLMHandler(llmModelRepo, llmRegistry)

	agentRepo := mongorepo.NewAgentRepo(agentsCol, llmRegistryCol)
	mcpServerRepo := mongorepo.NewMCPServerRepo(mcpServersCol)
	deploymentRevisionRepo := mongorepo.NewDeploymentRevisionRepo(deploymentRevisionsCol)
	deploymentStateRepo := mongorepo.NewDeploymentStateRepo(deploymentStatesCol)
	deploymentDeliveryTokenRepo := mongorepo.NewDeploymentDeliveryTokenRepo(deploymentDeliveryTokensCol)
	threadRepo := mongorepo.NewThreadRepo(threadsCol)
	messageRepo := mongorepo.NewMessageRepo(messagesCol)
	runRepo := mongorepo.NewRunRepo(runsCol, checkpointsCol)
	jobRepo := mongorepo.NewJobRepo(jobsCol, jobLocksCol)
	taskRepo := mongorepo.NewTaskRepo(tasksCol)
	resourceDependencyRepo := mongorepo.NewResourceDependencyRepo(agentsCol, threadsCol, deploymentRevisionsCol, deploymentStatesCol)
	workspaceStatsRepo := mongorepo.NewWorkspaceStatsRepo(runsCol, deploymentStatesCol)
	jobRepo.SetTaskBudgetStore(taskRepo)
	if err := mcpServerRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create MCP server indexes", "error", err)
		os.Exit(1)
	}

	if err := runRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create run indexes", "error", err)
		os.Exit(1)
	}
	if err := messageRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create message indexes", "error", err)
		os.Exit(1)
	}
	recovery, err := runRepo.RecoverOrphanedRuns(context.Background(), "")
	if err != nil {
		slog.Error("failed to recover orphaned runs", "error", err)
		os.Exit(1)
	}
	if recovery.Interrupted > 0 || recovery.Failed > 0 || recovery.Cancelled > 0 {
		slog.Info("recovered orphaned runs", "interrupted", recovery.Interrupted, "failed", recovery.Failed, "cancelled", recovery.Cancelled)
	}
	if count, err := handlers.ReconcileAcceptedPrompts(context.Background(), "", runRepo, messageRepo); err != nil {
		slog.Error("failed to reconcile accepted prompts", "error", err)
		os.Exit(1)
	} else if count > 0 {
		slog.Info("reconciled accepted prompts", "count", count)
	}
	if err := jobRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create job indexes", "error", err)
		os.Exit(1)
	}
	if err := taskRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create task indexes", "error", err)
		os.Exit(1)
	}
	if err := threadRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create thread indexes", "error", err)
		os.Exit(1)
	}
	if err := deploymentRevisionRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create deployment revision indexes", "error", err)
		os.Exit(1)
	}
	if err := deploymentStateRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create deployment state indexes", "error", err)
		os.Exit(1)
	}
	if err := deploymentDeliveryTokenRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create deployment delivery token indexes", "error", err)
		os.Exit(1)
	}

	platformPath := strings.TrimSpace(os.Getenv("PLATFORM_XML_PATH"))
	if platformPath == "" {
		platformPath = "platform.xml"
	}
	platformCfg, err := agent.LoadPlatformConfig(platformPath)
	if err != nil {
		slog.Error("failed to load platform config", "error", err, "path", platformPath)
		os.Exit(1)
	}
	contextBuilder := agent.NewContextBuilder(platformCfg, memorySvc, memoryMetaRepo, scratchpadSvc)
	publisherSvc, err := publisher.NewService(publisher.Config{
		Agents: agentRepo, Revisions: deploymentRevisionRepo, Platform: platformCfg,
		Catalog: toolCatalog, MCPServers: mcpServerRepo,
	})
	if err != nil {
		slog.Error("failed to initialize deployment publisher", "error", err)
		os.Exit(1)
	}
	capabilities := agent.ToolCapabilities{AsyncJobs: true}
	agentRuntime := agent.NewAgentRuntime(llmRegistry, toolRegistry, contextBuilder, capabilities).WithCheckpointStore(runRepo)
	agentRuntime.SetMCPManager(mcpManager) // must follow WithCheckpointStore (which copies a still-nil manager)
	agentRuntime.SetAsyncJobStore(jobRepo)
	summarizer := agent.NewSummarizer(llmRegistry)

	theBus := bus.NewInProc()
	jobHub := dispatcher.NewJobHub()
	taskEvents := agent.NewTaskEventHub()
	preparer := dispatcher.NewRunPreparer(dispatcher.RunPreparerConfig{
		Agents:       agentRepo,
		Threads:      threadRepo,
		Messages:     messageRepo,
		Runs:         runRepo,
		Summarizer:   summarizer,
		Runtime:      agentRuntime,
		ToolRegistry: toolRegistry,
		MCPServers:   mcpServerRepo,
		Tasks:        taskRepo,
		Background:   appCtx,
		Capabilities: capabilities,
	})
	pools := dispatcher.NewPoolManager(dispatcher.PoolManagerConfig{
		RootCtx:    appCtx,
		Bus:        theBus,
		Preparer:   preparer,
		Runtime:    agentRuntime,
		Status:     runRepo,
		Messages:   messageRepo,
		Jobs:       jobRepo,
		Tasks:      taskRepo,
		Hub:        jobHub,
		TaskEvents: taskEvents,
		Workers:    4,
	})
	invoker := dispatcher.NewBusDelegateInvoker(dispatcher.BusDelegateInvokerConfig{
		Bus:      theBus,
		Pools:    pools,
		Agents:   agentRepo,
		Threads:  threadRepo,
		Runs:     runRepo,
		Messages: messageRepo,
		Tasks:    taskRepo,
	})
	agentRuntime.SetDelegateInvoker(invoker)
	coordinator := dispatcher.NewJobCoordinator(dispatcher.JobCoordinatorConfig{
		Bus:        theBus,
		Pools:      pools,
		Threads:    threadRepo,
		Runs:       runRepo,
		Jobs:       jobRepo,
		Tasks:      taskRepo,
		Hub:        jobHub,
		TaskEvents: taskEvents,
		Logger:     slog.Default(),
	})
	coordinator.Start(appCtx)
	defer theBus.Close()

	var disp dispatcher.Dispatcher
	if os.Getenv("MESSAGEBUS_DISPATCH") == "true" {
		disp = &dispatcher.BusDispatcher{
			Bus:            theBus,
			Pools:          pools,
			Preparer:       preparer,
			RequestTimeout: 30 * time.Minute,
		}
		slog.Info("dispatcher: using BusDispatcher")
	} else {
		disp = &dispatcher.DirectDispatcher{
			Preparer: preparer,
			Runtime:  agentRuntime,
			Bus:      theBus,
			Pools:    pools,
		}
		slog.Info("dispatcher: using DirectDispatcher")
	}

	agentHandler := handlers.NewAgentHandler(agentRepo, toolRegistry, toolCatalog, mcpServerRepo, llmModelRepo, llmRegistry, resourceDependencyRepo)
	agentTeamHandler := handlers.NewAgentTeamHandler(agentRepo, toolRegistry, toolCatalog, mcpServerRepo, llmModelRepo, llmRegistry, resourceDependencyRepo)
	toolHandler := handlers.NewToolHandler(toolCatalog, toolRegistry)
	mcpServerHandler := handlers.NewMCPServerHandler(mcpServerRepo)
	platformHandler := handlers.NewPlatformHandler(managedDeployments.Enabled)
	workspaceHandler := handlers.NewWorkspaceHandler(
		agentRepo, llmModelRepo, llmRegistry, toolCatalog, toolRegistry,
		mcpServerRepo, workspaceStatsRepo, managedDeployments.Enabled,
	)
	publicationHandler := handlers.NewPublicationHandler(publisherSvc)
	artifactDeliverySvc, err := delivery.NewService(delivery.Config{
		Tokens: deploymentDeliveryTokenRepo, States: deploymentStateRepo, Revisions: deploymentRevisionRepo,
	})
	if err != nil {
		slog.Error("failed to initialize artifact delivery service", "error", err)
		os.Exit(1)
	}
	artifactHandler := handlers.NewArtifactHandler(artifactDeliverySvc)
	var deploymentController *reconciler.Controller
	if managedDeployments.Enabled {
		clusterConfig, err := rest.InClusterConfig()
		if err != nil {
			slog.Error("failed to load in-cluster Kubernetes configuration", "error", err)
			os.Exit(1)
		}
		clusterClient, err := kubeclient.NewForConfig(clusterConfig)
		if err != nil {
			slog.Error("failed to initialize Kubernetes client", "error", err)
			os.Exit(1)
		}
		deploymentSvc, err := deployment.NewService(deploymentStateRepo, deploymentRevisionRepo)
		if err != nil {
			slog.Error("failed to initialize managed deployment service", "error", err)
			os.Exit(1)
		}
		runtimeAdapter, err := deploymentkubernetes.NewRuntime(deploymentkubernetes.RuntimeConfig{
			Client: clusterClient, States: deploymentStateRepo, Delivery: artifactDeliverySvc,
			ArtifactBaseURL:           managedDeployments.ArtifactBaseURL,
			CredentialSourceNamespace: managedDeployments.CredentialSourceNamespace,
			CredentialSourceName:      managedDeployments.CredentialSourceName,
		})
		if err != nil {
			slog.Error("failed to initialize Kubernetes deployment runtime", "error", err)
			os.Exit(1)
		}
		deploymentController, err = reconciler.New(reconciler.Config{
			Store: deploymentStateRepo, Revisions: deploymentRevisionRepo,
			Runtime: runtimeAdapter, Owner: managedDeployments.ControllerOwner,
		})
		if err != nil {
			slog.Error("failed to initialize deployment controller", "error", err)
			os.Exit(1)
		}
		deploymentHandler, err := handlers.NewDeploymentHandler(
			deploymentSvc, managedDeployments.Namespace, managedDeployments.RuntimeImage, agentRepo,
		)
		if err != nil {
			slog.Error("failed to initialize deployment API", "error", err)
			os.Exit(1)
		}
		runtimeProxy, err := handlers.NewRuntimeProxyHandler(deploymentSvc, runtimeAdapter, nil)
		if err != nil {
			slog.Error("failed to initialize runtime proxy", "error", err)
			os.Exit(1)
		}
		mux.HandleFunc("GET /api/deployments", middleware.RequireAuth(deploymentHandler.List))
		mux.HandleFunc("PUT /api/agents/{id}/deployment", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, deploymentHandler.Deploy)))
		mux.HandleFunc("DELETE /api/agents/{id}/deployment", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, deploymentHandler.Undeploy)))
		mux.HandleFunc("GET /api/agents/{id}/deployment", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, deploymentHandler.Status)))
		mux.HandleFunc("/api/agents/{id}/runtime/{path...}", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, runtimeProxy.ServeHTTP)))
		mux.HandleFunc("PUT /api/agent-teams/{id}/deployment", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, deploymentHandler.Deploy)))
		mux.HandleFunc("DELETE /api/agent-teams/{id}/deployment", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, deploymentHandler.Undeploy)))
		mux.HandleFunc("GET /api/agent-teams/{id}/deployment", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, deploymentHandler.Status)))
		mux.HandleFunc("/api/agent-teams/{id}/runtime/{path...}", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, runtimeProxy.ServeHTTP)))
	}
	threadHandler := handlers.NewThreadHandler(threadRepo, agentRepo)
	executions := handlers.NewExecutionRegistryWithTaskEvents(appCtx, taskEvents)
	messageHandler := handlers.NewMessageHandler(
		agentRepo,
		threadRepo,
		messageRepo,
		disp,
		runRepo,
		executions,
	)
	runHandler := handlers.NewRunHandler(
		agentRepo,
		threadRepo,
		messageRepo,
		runRepo,
		disp,
		toolRegistry,
		capabilities,
		executions,
	)
	jobHandler := handlers.NewJobHandler(threadRepo, jobRepo)

	mux.HandleFunc("POST /api/auth/signup", authHandler.SignUp)
	mux.HandleFunc("POST /api/auth/login", authHandler.Login)
	mux.HandleFunc("GET /api/auth/me", middleware.RequireAuth(authHandler.Me))
	mux.HandleFunc("GET /api/platform/capabilities", middleware.RequireAuth(platformHandler.Capabilities))
	mux.HandleFunc("GET /api/workspace/overview", middleware.RequireAuth(workspaceHandler.Overview))
	mux.HandleFunc("GET /api/llms", middleware.RequireAuth(llmHandler.GetLLMs))
	mux.HandleFunc("GET /api/tools", middleware.RequireAuth(toolHandler.List))
	mux.HandleFunc("GET /api/mcp-servers", middleware.RequireAuth(mcpServerHandler.List))
	mux.HandleFunc("POST /api/llm/chat", middleware.RequireAuth(llmHandler.Chat))
	mux.HandleFunc("POST /api/agents", middleware.RequireAuth(agentHandler.Create))
	mux.HandleFunc("GET /api/agents", middleware.RequireAuth(agentHandler.List))
	mux.HandleFunc("GET /api/agents/{id}", middleware.RequireAuth(agentHandler.Get))
	mux.HandleFunc("PATCH /api/agents/{id}", middleware.RequireAuth(agentHandler.Update))
	mux.HandleFunc("DELETE /api/agents/{id}", middleware.RequireAuth(agentHandler.Delete))
	mux.HandleFunc("POST /api/agent-teams", middleware.RequireAuth(agentTeamHandler.Create))
	mux.HandleFunc("GET /api/agent-teams", middleware.RequireAuth(agentTeamHandler.List))
	mux.HandleFunc("GET /api/agent-teams/{id}", middleware.RequireAuth(agentTeamHandler.Get))
	mux.HandleFunc("PATCH /api/agent-teams/{id}", middleware.RequireAuth(agentTeamHandler.Update))
	mux.HandleFunc("DELETE /api/agent-teams/{id}", middleware.RequireAuth(agentTeamHandler.Delete))
	mux.HandleFunc("POST /api/agents/{id}/publish", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, publicationHandler.Publish)))
	mux.HandleFunc("GET /api/agents/{id}/publications", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, publicationHandler.List)))
	mux.HandleFunc("GET /api/agents/{id}/publications/{revision}/bundle", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, publicationHandler.GetBundle)))
	mux.HandleFunc("POST /api/agents/{id}/publications/{revision}/restore", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindStandaloneAgent, publicationHandler.Restore)))
	mux.HandleFunc("POST /api/agent-teams/{id}/publish", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, publicationHandler.Publish)))
	mux.HandleFunc("GET /api/agent-teams/{id}/publications", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, publicationHandler.List)))
	mux.HandleFunc("GET /api/agent-teams/{id}/publications/{revision}/bundle", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, publicationHandler.GetBundle)))
	mux.HandleFunc("POST /api/agent-teams/{id}/publications/{revision}/restore", middleware.RequireAuth(handlers.RequireResourceKind(agentRepo, agent.ResourceKindAgentTeam, publicationHandler.Restore)))
	mux.HandleFunc("POST /api/agents/{id}/threads", middleware.RequireAuth(threadHandler.Create))
	mux.HandleFunc("GET /api/agents/{id}/threads", middleware.RequireAuth(threadHandler.ListByAgent))
	mux.HandleFunc("POST /api/agent-teams/{id}/threads", middleware.RequireAuth(threadHandler.CreateForTeam))
	mux.HandleFunc("GET /api/agent-teams/{id}/threads", middleware.RequireAuth(threadHandler.ListByTeam))
	mux.HandleFunc("GET /api/threads", middleware.RequireAuth(threadHandler.List))
	mux.HandleFunc("GET /api/threads/{id}", middleware.RequireAuth(threadHandler.Get))
	mux.HandleFunc("PATCH /api/threads/{id}", middleware.RequireAuth(threadHandler.Update))
	mux.HandleFunc("POST /api/threads/{id}/messages", middleware.RequireAuth(messageHandler.Send))
	mux.HandleFunc("GET /api/threads/{id}/messages", middleware.RequireAuth(messageHandler.List))
	mux.HandleFunc("GET /api/threads/{id}/runs", middleware.RequireAuth(runHandler.ListByThread))
	mux.HandleFunc("GET /api/threads/{id}/jobs", middleware.RequireAuth(jobHandler.ListByThread))
	mux.HandleFunc("GET /api/runs", middleware.RequireAuth(runHandler.List))
	mux.HandleFunc("GET /api/runs/{id}", middleware.RequireAuth(runHandler.GetRun))
	mux.HandleFunc("GET /api/runs/{id}/events", middleware.RequireAuth(runHandler.StreamEvents))
	mux.HandleFunc("POST /api/runs/{id}/resume", middleware.RequireAuth(runHandler.ResumeRun))
	mux.HandleFunc("POST /api/runs/{id}/cancel", middleware.RequireAuth(runHandler.CancelRun))

	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
	}

	const maxRequestBodyBytes = 1 << 20 // 1 MiB — sufficient for all current endpoints

	server := &http.Server{
		Addr: ":" + port,
		Handler: middleware.RequestID(
			loggingMiddleware(
				corsMiddleware(
					middleware.BodyLimit(maxRequestBodyBytes)(mux),
				),
			),
		),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	internalAddr := strings.TrimSpace(os.Getenv("ARTIFACT_LISTEN_ADDR"))
	var artifactServer *http.Server
	if internalAddr != "" {
		internalMux := http.NewServeMux()
		internalMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		})
		internalMux.HandleFunc(
			"GET /internal/v1/deployments/{deployment}/generations/{generation}/revisions/{revision}/bundle",
			artifactHandler.GetBundle,
		)
		artifactServer = &http.Server{
			Addr:              internalAddr,
			Handler:           middleware.RequestID(loggingMiddleware(internalMux)),
			ReadHeaderTimeout: 5 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       120 * time.Second,
			MaxHeaderBytes:    32 << 10,
		}
	}

	slog.Info("server listening", "addr", "http://localhost:"+port)
	serveErrors := make(chan error, 3)
	var controllerDone <-chan struct{}
	if deploymentController != nil {
		done := make(chan struct{})
		controllerDone = done
		go func() {
			defer close(done)
			if err := deploymentController.Run(appCtx); err != nil {
				serveErrors <- fmt.Errorf("deployment controller: %w", err)
			} else if appCtx.Err() == nil {
				serveErrors <- errors.New("deployment controller stopped unexpectedly")
			}
		}()
		slog.Info("managed deployment controller started", "owner", managedDeployments.ControllerOwner)
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrors <- fmt.Errorf("public server: %w", err)
		}
	}()
	if artifactServer != nil {
		slog.Info("internal artifact server listening", "addr", artifactServer.Addr)
		go func() {
			if err := artifactServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				serveErrors <- fmt.Errorf("artifact server: %w", err)
			}
		}()
	} else {
		slog.Info("internal artifact delivery disabled; ARTIFACT_LISTEN_ADDR is not set")
	}
	var serveErr error
	select {
	case <-appCtx.Done():
	case serveErr = <-serveErrors:
		slog.Error("server stopped unexpectedly", "error", serveErr)
		stop()
	}

	// Shut down both trust-boundary listeners together. A 30-second window
	// covers in-flight SSE streams on the public listener.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("public server graceful shutdown failed", "error", err)
	}
	if artifactServer != nil {
		if err := artifactServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("artifact server graceful shutdown failed", "error", err)
		}
	}
	if controllerDone != nil {
		select {
		case <-controllerDone:
		case <-shutdownCtx.Done():
			slog.Error("deployment controller graceful shutdown timed out")
		}
	}
	pools.StopAll()
	_ = theBus.Close()
	if serveErr != nil {
		os.Exit(1)
	}
}

func methodNotAllowed(w http.ResponseWriter, allowedMethod string) {
	w.Header().Set("Allow", allowedMethod)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
		"error": "method not allowed",
	})
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)

	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("failed to encode JSON response", "error", err)
	}
}
