package main

import (
	"backend/agent"
	"backend/db"
	"backend/handlers"
	"backend/llm"
	"backend/middleware"
	"backend/repository"
	"backend/tools"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
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
		if r.Method != "OPTIONS" {
			log.Printf("[%s] %s - Request initiated", r.Method, r.URL.Path)
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		if r.Method != "OPTIONS" {
			log.Printf("[%s] %s - Completed in %v\n--", r.Method, r.URL.Path, time.Since(start))
		}
	})
}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found or error loading it. Proceeding with system environment variables.")
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
	threadsCol := db.GetCollection(dbName, "threads")
	messagesCol := db.GetCollection(dbName, "messages")
	runsCol := db.GetCollection(dbName, "runs")
	checkpointsCol := db.GetCollection(dbName, "run_checkpoints")

	authHandler := &handlers.AuthHandler{
		Users: usersCol,
	}

	llmRegistry := llm.NewLLMRegistry()
	toolRegistry := tools.NewToolRegistry()

	llmHandler := &handlers.LLMHandler{
		LLMRegistry: llmRegistryCol,
		Registry:    llmRegistry,
	}

	agentRepo := repository.NewAgentRepo(agentsCol, llmRegistryCol)
	threadRepo := repository.NewThreadRepo(threadsCol)
	messageRepo := repository.NewMessageRepo(messagesCol)
	runRepo := repository.NewRunRepo(runsCol, checkpointsCol)

	if err := runRepo.EnsureIndexes(context.Background()); err != nil {
		log.Fatalf("failed to create run indexes: %v", err)
	}

	agentRuntime := agent.NewAgentRuntime(llmRegistry, toolRegistry).WithCheckpointStore(runRepo)
	summarizer := agent.NewSummarizer(llmRegistry)

	agentHandler := handlers.NewAgentHandler(agentRepo)
	threadHandler := handlers.NewThreadHandler(threadRepo, agentRepo)
	messageHandler := handlers.NewMessageHandler(
		agentRepo,
		threadRepo,
		messageRepo,
		agentRuntime,
		summarizer,
		runRepo,
	)
	runHandler := handlers.NewRunHandler(
		agentRepo,
		threadRepo,
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

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           loggingMiddleware(corsMiddleware(mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("server listening on http://localhost:%s", port)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("failed to start server: %v", err)
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
		log.Printf("failed to encode JSON response: %v", err)
	}
}
