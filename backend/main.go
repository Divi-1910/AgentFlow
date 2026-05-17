package main

import (
	"backend/agent"
	"backend/db"
	"backend/handlers"
	"backend/llm"
	"backend/memory"
	"backend/middleware"
	"backend/repository"
	"backend/tools"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
)

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:5173")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization")

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
	threadsCol := db.GetCollection(dbName, "threads")
	messagesCol := db.GetCollection(dbName, "messages")
	runsCol := db.GetCollection(dbName, "runs")
	checkpointsCol := db.GetCollection(dbName, "run_checkpoints")

	userRepo := repository.NewUserRepo(usersCol)
	authHandler := handlers.NewAuthHandler(userRepo, nil) // nil → defaults to auth.GenerateToken

	llmRegistry := llm.NewLLMRegistry()

	memorySvc, err := memory.NewServiceFromEnv()
	if err != nil {
		slog.Error("failed to initialize memory service", "error", err)
		os.Exit(1)
	}

	toolRegistry := tools.NewToolRegistry(db.GetRedis(), memorySvc)

	llmModelRepo := repository.NewLLMModelRepo(llmRegistryCol)
	llmHandler := handlers.NewLLMHandler(llmModelRepo, llmRegistry)

	agentRepo := repository.NewAgentRepo(agentsCol, llmRegistryCol)
	threadRepo := repository.NewThreadRepo(threadsCol)
	messageRepo := repository.NewMessageRepo(messagesCol)
	runRepo := repository.NewRunRepo(runsCol, checkpointsCol)

	if err := runRepo.EnsureIndexes(context.Background()); err != nil {
		slog.Error("failed to create run indexes", "error", err)
		os.Exit(1)
	}

	agentRuntime := agent.NewAgentRuntime(llmRegistry, toolRegistry).WithCheckpointStore(runRepo)
	summarizer := agent.NewSummarizer(llmRegistry)

	agentHandler := handlers.NewAgentHandler(agentRepo, toolRegistry)
	threadHandler := handlers.NewThreadHandler(threadRepo, agentRepo)
	messageHandler := handlers.NewMessageHandler(
		agentRepo,
		threadRepo,
		messageRepo,
		agentRuntime,
		summarizer,
		runRepo,
		appCtx,
	)
	runHandler := handlers.NewRunHandler(
		agentRepo,
		messageRepo,
		runRepo,
		agentRuntime,
		toolRegistry,
	)

	mux.HandleFunc("POST /api/auth/signup", authHandler.SignUp)
	mux.HandleFunc("POST /api/auth/login", authHandler.Login)
	mux.HandleFunc("GET /api/auth/me", middleware.RequireAuth(authHandler.Me))

	mux.HandleFunc("GET /api/llms", middleware.RequireAuth(llmHandler.GetLLMs))
	mux.HandleFunc("POST /api/llm/chat", middleware.RequireAuth(llmHandler.Chat))

	mux.HandleFunc("POST /api/agents", middleware.RequireAuth(agentHandler.Create))
	mux.HandleFunc("GET /api/agents", middleware.RequireAuth(agentHandler.List))
	mux.HandleFunc("GET /api/agents/{id}", middleware.RequireAuth(agentHandler.Get))
	mux.HandleFunc("PUT /api/agents/{id}", middleware.RequireAuth(agentHandler.Update))
	mux.HandleFunc("DELETE /api/agents/{id}", middleware.RequireAuth(agentHandler.Delete))

	mux.HandleFunc("POST /api/agents/{id}/threads", middleware.RequireAuth(threadHandler.Create))
	mux.HandleFunc("GET /api/agents/{id}/threads", middleware.RequireAuth(threadHandler.ListByAgent))

	mux.HandleFunc("POST /api/threads/{id}/messages", middleware.RequireAuth(messageHandler.Send))
	mux.HandleFunc("GET /api/threads/{id}/messages", middleware.RequireAuth(messageHandler.List))

	mux.HandleFunc("GET /api/runs/{id}", middleware.RequireAuth(runHandler.GetRun))
	mux.HandleFunc("POST /api/runs/{id}/resume", middleware.RequireAuth(runHandler.ResumeRun))

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

	slog.Info("server listening", "addr", "http://localhost:"+port)

	// Shut down gracefully on SIGINT/SIGTERM. A 30-second window covers
	// in-flight SSE streams; after that the OS will force-close.
	go func() {
		<-appCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("graceful shutdown failed", "error", err)
		}
	}()

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server stopped", "error", err)
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
