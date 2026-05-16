package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
	"backend/llm"
	"backend/middleware"
	"backend/repository"
	"backend/tools"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var testDB *mongo.Database

func TestMain(m *testing.M) {
	// auth.GenerateToken and auth.ValidateToken both call log.Fatal when
	// JWT_SECRET is missing. Set it once for the entire test run.
	os.Setenv("JWT_SECRET", "handler-integration-test-secret")
	defer os.Unsetenv("JWT_SECRET")

	uri := os.Getenv("MONGO_TEST_URI")
	if uri == "" {
		uri = "mongodb://localhost:27017"
	}

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		panic("integration: failed to connect to MongoDB: " + err.Error())
	}

	// Use a distinct DB name so parallel runs with repository tests don't collide.
	testDB = client.Database("HandlerTestDB")
	_ = testDB.Drop(context.Background()) // clean start

	code := m.Run()

	_ = testDB.Drop(context.Background())
	_ = client.Disconnect(context.Background())
	os.Exit(code)
}

// ── testEnv ───────────────────────────────────────────────────────────────────

// testEnv holds a fully-wired httptest.Server and the repos needed for
// test-side data setup (e.g. pre-seeding a run document).
type testEnv struct {
	srv         *httptest.Server
	runRepo     *repository.RunRepo     // exposed for run tests
	llmModelCol *mongo.Collection       // exposed for LLM model seeding
}

// newTestEnv creates a fresh HTTP test server for the calling test.
// Every collection is test-scoped (named after t.Name()) and auto-dropped.
func newTestEnv(t *testing.T) *testEnv {
	t.Helper()

	col := func(prefix string) *mongo.Collection {
		c := testDB.Collection(prefix + "_" + sanitize(t.Name()))
		t.Cleanup(func() { _ = c.Drop(context.Background()) })
		return c
	}

	// Real repos ──────────────────────────────────────────────────────────────
	userRepo     := repository.NewUserRepo(col("users"))
	agentRepo    := repository.NewAgentRepo(col("agents"), col("models"))
	threadRepo   := repository.NewThreadRepo(col("threads"))
	messageRepo  := repository.NewMessageRepo(col("messages"))
	llmModelCol  := col("llm_models")
	llmModelRepo := repository.NewLLMModelRepo(llmModelCol)
	runRepo      := repository.NewRunRepo(col("runs"), col("checkpoints"))
	if err := runRepo.EnsureIndexes(context.Background()); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}

	// Stubs ───────────────────────────────────────────────────────────────────
	rt      := &stubRuntime{}
	summ    := &stubSummarizer{}
	llmReg  := llm.NewEmptyLLMRegistry()
	toolReg := tools.NewEmptyRegistry()

	// Handlers ────────────────────────────────────────────────────────────────
	authHandler   := handlers.NewAuthHandler(userRepo, nil) // nil → real auth.GenerateToken
	agentHandler  := handlers.NewAgentHandler(agentRepo, toolReg)
	threadHandler := handlers.NewThreadHandler(threadRepo, agentRepo)
	msgHandler    := handlers.NewMessageHandler(
		agentRepo, threadRepo, messageRepo, rt, summ, runRepo, context.Background(),
	)
	llmHandler := handlers.NewLLMHandler(llmModelRepo, llmReg)
	runHandler := handlers.NewRunHandler(agentRepo, threadRepo, messageRepo, runRepo, rt, toolReg)

	// Routing — mirrors main.go ────────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/signup", authHandler.SignUp)
	mux.HandleFunc("POST /api/auth/login",  authHandler.Login)
	mux.HandleFunc("GET /api/auth/me",      middleware.RequireAuth(authHandler.Me))

	mux.HandleFunc("GET /api/llms",      middleware.RequireAuth(llmHandler.GetLLMs))
	mux.HandleFunc("POST /api/llm/chat", middleware.RequireAuth(llmHandler.Chat))

	mux.HandleFunc("POST /api/agents",        middleware.RequireAuth(agentHandler.Create))
	mux.HandleFunc("GET /api/agents",         middleware.RequireAuth(agentHandler.List))
	mux.HandleFunc("GET /api/agents/{id}",    middleware.RequireAuth(agentHandler.Get))
	mux.HandleFunc("PUT /api/agents/{id}",    middleware.RequireAuth(agentHandler.Update))
	mux.HandleFunc("DELETE /api/agents/{id}", middleware.RequireAuth(agentHandler.Delete))

	mux.HandleFunc("POST /api/agents/{id}/threads", middleware.RequireAuth(threadHandler.Create))
	mux.HandleFunc("GET /api/agents/{id}/threads",  middleware.RequireAuth(threadHandler.ListByAgent))

	mux.HandleFunc("POST /api/threads/{id}/messages", middleware.RequireAuth(msgHandler.Send))
	mux.HandleFunc("GET /api/threads/{id}/messages",  middleware.RequireAuth(msgHandler.List))

	mux.HandleFunc("GET /api/runs/{id}",         middleware.RequireAuth(runHandler.GetRun))
	mux.HandleFunc("POST /api/runs/{id}/resume", middleware.RequireAuth(runHandler.ResumeRun))

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return &testEnv{srv: srv, runRepo: runRepo, llmModelCol: llmModelCol}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func (e *testEnv) url(path string) string { return e.srv.URL + path }

// do executes an HTTP request against the test server.
// body is marshalled to JSON when non-nil. token is sent as Bearer when non-empty.
func (e *testEnv) do(t *testing.T, method, path string, body any, token string) *http.Response {
	t.Helper()
	var br io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		br = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.url(path), br)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do %s %s: %v", method, path, err)
	}
	return resp
}

// mustSignup signs a user up, then logs in, and returns the JWT token.
func (e *testEnv) mustSignup(t *testing.T, email, password string) string {
	t.Helper()
	resp := e.do(t, "POST", "/api/auth/signup", map[string]any{
		"first_name": "Test",
		"last_name":  "User",
		"email":      email,
		"password":   password,
	}, "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup %s: expected 201, got %d", email, resp.StatusCode)
	}

	resp = e.do(t, "POST", "/api/auth/login", map[string]any{
		"email":    email,
		"password": password,
	}, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login %s: expected 200, got %d", email, resp.StatusCode)
	}
	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if result.Token == "" {
		t.Fatal("login returned empty token")
	}
	return result.Token
}

// decodeBody reads and closes resp.Body, unmarshalling JSON into dst.
func decodeBody(t *testing.T, resp *http.Response, dst any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		t.Fatalf("decode response body: %v", err)
	}
}

func sanitize(s string) string {
	r := strings.NewReplacer("/", "_", ":", "_", " ", "_")
	return r.Replace(s)
}

// ── stubs ─────────────────────────────────────────────────────────────────────

// stubRuntime immediately completes a run with one assistant message.
// It sends EventRunStarted (non-terminal → written to SSE body) and
// EventRunCompleted (terminal → captured for post-loop emit), then closes
// the events channel so streamLoop exits cleanly.
type stubRuntime struct{}

func (s *stubRuntime) RunStream(
	ctx context.Context,
	ag *agent.Agent,
	runCtx agent.RunContext,
	events chan<- agent.StreamEvent,
) (*agent.RunResult, error) {
	events <- agent.StreamEvent{Type: agent.EventRunStarted, RunID: runCtx.RunID, Time: time.Now()}
	events <- agent.StreamEvent{Type: agent.EventRunCompleted, RunID: runCtx.RunID, Time: time.Now()}
	close(events)
	return &agent.RunResult{
		NewMessages: []llm.ChatMessage{{Role: "assistant", Content: "stub response"}},
		Steps:       1,
	}, nil
}

// stubSummarizer returns immediately with a no-op summary.
type stubSummarizer struct{}

func (s *stubSummarizer) Summarize(
	ctx context.Context,
	ag *agent.Agent,
	existingSummary string,
	turns []agent.Turn,
) (string, llm.TokenUsage, error) {
	return "stub summary", llm.TokenUsage{}, nil
}
