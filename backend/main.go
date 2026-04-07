package main

import (
	"backend/db"
	"backend/handlers"
	"backend/llm"
	"backend/middleware"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
)

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:5173")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

func loggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "OPTIONS" {
			log.Printf("[%s] %s - Request initiated", r.Method, r.URL.Path)
		}
		start := time.Now()
		next(w, r)
		if r.Method != "OPTIONS" {
			log.Printf("[%s] %s - Completed in %v\n--", r.Method, r.URL.Path, time.Since(start))
		}
	}
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

	authHandler := &handlers.AuthHandler{
		Users: db.GetCollection("AgentFlow", "users"),
	}

	llmRegistry := llm.NewRegistry()

	llmHandler := &handlers.LLMHandler{
		LLMRegistry: db.GetCollection("AgentFlow", "llm_registry"),
		Registry:    llmRegistry,
	}

	mux.HandleFunc("/api/auth/signup", loggingMiddleware(corsMiddleware(authHandler.SignUp)))
	mux.HandleFunc("/api/auth/login", loggingMiddleware(corsMiddleware(authHandler.Login)))
	mux.HandleFunc("/api/auth/me", loggingMiddleware(corsMiddleware(middleware.RequireAuth(authHandler.Me))))

	mux.HandleFunc("/api/llms", loggingMiddleware(corsMiddleware(middleware.RequireAuth(llmHandler.GetLLMs))))

	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
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
