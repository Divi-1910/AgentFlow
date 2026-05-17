package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
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
	runRepo     *repository.RunRepo // exposed for run tests
	llmModelCol *mongo.Collection   // exposed for LLM model seeding
}

// runtimeFn mirrors the unexported handlers.runtimeExecutor interface.
// Both stubRuntime and scriptedRuntime satisfy this.
type runtimeFn interface {
	RunStream(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext, events chan<- agent.StreamEvent) (*agent.RunResult, error)
	EstimateSystemPromptTokens(ctx context.Context, ag *agent.Agent, runCtx agent.RunContext) int
}

// newTestEnv creates a fresh HTTP test server backed by a stubRuntime.
func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	return newTestEnvWithRuntime(t, &stubRuntime{})
}

// newTestEnvWithRuntime creates a fresh HTTP test server using the supplied
// runtime. Every collection is test-scoped (named after t.Name()) and
// auto-dropped on test cleanup.
func newTestEnvWithRuntime(t *testing.T, rt runtimeFn) *testEnv {
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
	runHandler := handlers.NewRunHandler(agentRepo, messageRepo, runRepo, rt, toolReg)

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

// mustGetUserID fetches the authenticated user's ID from GET /api/auth/me.
// The Me endpoint returns {"user": {"id": "...", ...}}.
func (e *testEnv) mustGetUserID(t *testing.T, token string) string {
	t.Helper()
	resp := e.do(t, "GET", "/api/auth/me", nil, token)
	var body struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	decodeBody(t, resp, &body)
	if body.User.ID == "" {
		t.Fatal("GET /api/auth/me: empty user ID")
	}
	return body.User.ID
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

// EstimateSystemPromptTokens returns 0 so the message handler falls back to
// the conservative agent.ShouldSummarize heuristic in tests.
func (s *stubRuntime) EstimateSystemPromptTokens(_ context.Context, _ *agent.Agent, _ agent.RunContext) int {
	return 0
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

// ── scriptedRuntime ───────────────────────────────────────────────────────────

// scriptedCall describes one invocation of RunStream: the events to emit
// (in order), the result to return, and an optional error.
type scriptedCall struct {
	events []agent.StreamEvent
	result *agent.RunResult
	err    error
}

// scriptedRuntime replays pre-configured calls in sequence. Each call to
// RunStream emits the next entry's events, closes the channel, and returns
// the configured result/error. If more calls arrive than configured, it
// returns an error so the test notices.
type scriptedRuntime struct {
	mu      sync.Mutex
	calls   []scriptedCall
	callIdx int
}

func (s *scriptedRuntime) RunStream(
	ctx context.Context,
	ag *agent.Agent,
	runCtx agent.RunContext,
	events chan<- agent.StreamEvent,
) (*agent.RunResult, error) {
	s.mu.Lock()
	if s.callIdx >= len(s.calls) {
		idx := s.callIdx
		s.mu.Unlock()
		close(events)
		return nil, fmt.Errorf("scriptedRuntime: no call configured for invocation %d (have %d)", idx+1, len(s.calls))
	}
	call := s.calls[s.callIdx]
	s.callIdx++
	s.mu.Unlock()

	for _, e := range call.events {
		e.RunID = runCtx.RunID
		events <- e
	}
	close(events)
	return call.result, call.err
}

// EstimateSystemPromptTokens returns 0 so the message handler falls back to
// the conservative agent.ShouldSummarize heuristic in tests.
func (s *scriptedRuntime) EstimateSystemPromptTokens(_ context.Context, _ *agent.Agent, _ agent.RunContext) int {
	return 0
}
