package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"backend/agent"
	"backend/deployment"
	"backend/llm"
	"backend/repo/sqliterepo"
	"backend/tools"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func stage2MCPManager() *tools.MCPManager {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		status := http.StatusOK
		body := ""
		switch request.Method {
		case "initialize":
			header.Set("Mcp-Session-Id", "runtime-stage2")
			body = fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18"}}`, request.ID)
		case "notifications/initialized":
			status = http.StatusAccepted
		case "tools/list":
			body = fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"lookup","description":"Context7 lookup","inputSchema":{"type":"object"}}]}}`, request.ID)
		case "tools/call":
			body = fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"context7-result"}],"isError":false}}`, request.ID)
		}
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	return tools.NewMCPManagerWithURLValidator(client, func(string) error { return nil })
}

type stage2LLM struct{}

func (stage2LLM) ChatCompletion(_ context.Context, req *llm.ChatRequest) (*llm.ChatResponse, error) {
	if req.Model == "researcher" {
		var sawContext, sawScratchpad bool
		for _, message := range req.Messages {
			if message.Role != "tool" {
				continue
			}
			sawContext = sawContext || strings.Contains(message.Content, "context7-result")
			sawScratchpad = sawScratchpad || strings.Contains(message.Content, "file_id")
		}
		if !sawContext {
			return &llm.ChatResponse{Model: req.Model, ToolCalls: []llm.ToolCall{{
				ID: "context7-call", Name: "mcp__context7__lookup", Arguments: json.RawMessage(`{"topic":"sqlite"}`),
			}}}, nil
		}
		if !sawScratchpad {
			return &llm.ChatResponse{Model: req.Model, ToolCalls: []llm.ToolCall{{
				ID: "scratchpad-call", Name: "scratchpad_create", Arguments: json.RawMessage(`{"title":"Research","heading":"Context7","content":"SQLite findings from Context7"}`),
			}}}, nil
		}
		return &llm.ChatResponse{Model: req.Model, Content: "researcher complete"}, nil
	}
	for _, message := range req.Messages {
		if message.Role == "tool" {
			return &llm.ChatResponse{Model: req.Model, Content: "supervisor final answer"}, nil
		}
	}
	return &llm.ChatResponse{Model: req.Model, ToolCalls: []llm.ToolCall{{
		ID: "delegate-call", Name: "ask_researcher", Arguments: json.RawMessage(`{"task":"Research SQLite with Context7 and save findings"}`),
	}}}, nil
}

type shutdownBlockingLLM struct {
	entered  chan struct{}
	canceled chan struct{}
	release  chan struct{}
	once     sync.Once
}

func (f *shutdownBlockingLLM) ChatCompletion(ctx context.Context, _ *llm.ChatRequest) (*llm.ChatResponse, error) {
	f.once.Do(func() { close(f.entered) })
	<-ctx.Done()
	close(f.canceled)
	<-f.release
	return nil, ctx.Err()
}

func runtimeTestBundle(t *testing.T) *deployment.Bundle {
	t.Helper()
	b := &deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion, DeploymentID: "runtime-test", RootAgentID: "supervisor",
		PlatformXML: "<platform>test</platform>",
		Agents: []deployment.BundleAgent{{
			ID: "supervisor", Name: "Supervisor", Provider: "openai", Model: "test", SystemPrompt: "test",
			Tools: []string{"calculator"}, Delegates: []deployment.BundleDelegate{}, MCPServers: []deployment.BundleMCPServer{},
			ModelContextLimit: 1000, ContextWindow: 6, ContextKeepRatio: .5,
			MaxSteps: 10, Temperature: .1, MaxTokens: 100, MaxRuns: 10,
		}},
	}
	hash, err := b.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	b.ConfigHash = hash
	return b
}

func TestRuntimeHistorySurvivesCloseAndReopen(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	dataDir := filepath.Join(t.TempDir(), "data")
	bundle := runtimeTestBundle(t)
	app, err := newRuntimeApp(context.Background(), appConfig{
		bundle: bundle, dataDir: dataDir, auth: authConfig{mode: authModeNone},
	})
	if err != nil {
		t.Fatal(err)
	}

	create := httptest.NewRequest(http.MethodPost, "/v1/threads", bytes.NewBufferString(`{"title":"Persistent"}`))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	app.server.Handler.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", created.Code, created.Body.String())
	}
	var thread agent.ThreadRecord
	if err := json.Unmarshal(created.Body.Bytes(), &thread); err != nil {
		t.Fatal(err)
	}
	messages := sqliterepo.NewMessageRepo(app.db)
	if _, err := messages.InsertMany(context.Background(), thread.ID, bundle.RootAgentID, bundle.SyntheticUserID(), []llm.ChatMessage{{
		Role: "assistant", Content: "persisted answer", Metadata: map[string]any{"source": "restart-test"},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := app.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	reopened, err := newRuntimeApp(context.Background(), appConfig{
		bundle: bundle, dataDir: dataDir, auth: authConfig{mode: authModeNone},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Shutdown(context.Background()) })
	list := httptest.NewRequest(http.MethodGet, "/v1/threads/"+thread.ID+"/messages", nil)
	listed := httptest.NewRecorder()
	reopened.server.Handler.ServeHTTP(listed, list)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte("persisted answer")) || !bytes.Contains(listed.Body.Bytes(), []byte("restart-test")) {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
}

func TestRuntimeStage2SupervisorResearcherMCPAndScratchpad(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "stage2")
	bundle := &deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion, DeploymentID: "stage2", RootAgentID: "supervisor",
		PlatformXML: "<platform>stage2</platform>",
		Agents: []deployment.BundleAgent{
			{
				ID: "supervisor", Name: "Supervisor", Provider: "fake", Model: "supervisor", SystemPrompt: "supervise",
				Tools: []string{}, Delegates: []deployment.BundleDelegate{{AgentID: "researcher", ToolName: "ask_researcher", Description: "delegate research"}}, MCPServers: []deployment.BundleMCPServer{},
				ModelContextLimit: 1000, ContextWindow: 6, ContextKeepRatio: .5, MaxSteps: 8, Temperature: .1, MaxTokens: 100, MaxRuns: 10,
			},
			{
				ID: "researcher", Name: "Researcher", Provider: "fake", Model: "researcher", SystemPrompt: "research",
				Tools: []string{"scratchpad_create"}, Delegates: []deployment.BundleDelegate{}, MCPServers: []deployment.BundleMCPServer{{Alias: "context7", URL: "http://mcp.test"}},
				ModelContextLimit: 1000, ContextWindow: 6, ContextKeepRatio: .5, MaxSteps: 8, Temperature: .1, MaxTokens: 100, MaxRuns: 10,
			},
		},
	}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	bundle.ConfigHash = hash
	providers := llm.NewEmptyLLMRegistry()
	providers.Register("fake", stage2LLM{})
	app, err := newRuntimeApp(context.Background(), appConfig{
		bundle: bundle, dataDir: dataDir, auth: authConfig{mode: authModeNone}, providers: providers, mcpManager: stage2MCPManager(),
		validateMCPURL: func(string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Shutdown(context.Background()) })

	created := httptest.NewRecorder()
	app.server.Handler.ServeHTTP(created, httptest.NewRequest(http.MethodPost, "/v1/threads", bytes.NewBufferString(`{"title":"Stage 2"}`)))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var thread agent.ThreadRecord
	if err := json.Unmarshal(created.Body.Bytes(), &thread); err != nil {
		t.Fatal(err)
	}
	sent := httptest.NewRecorder()
	app.server.Handler.ServeHTTP(sent, httptest.NewRequest(http.MethodPost, "/v1/threads/"+thread.ID+"/messages", bytes.NewBufferString(`{"content":"Please research SQLite"}`)))
	if sent.Code != http.StatusOK || !strings.Contains(sent.Body.String(), "supervisor final answer") {
		t.Fatalf("send status=%d body=%s", sent.Code, sent.Body.String())
	}

	var childCount, subThreadCount, budgetUsed int
	if err := app.db.QueryRow(`SELECT count(*) FROM runs WHERE parent_run_id <> '' AND originator_run_id = (SELECT run_id FROM runs WHERE parent_run_id = '' LIMIT 1)`).Scan(&childCount); err != nil {
		t.Fatal(err)
	}
	if err := app.db.QueryRow(`SELECT count(*) FROM threads WHERE kind = 'sub'`).Scan(&subThreadCount); err != nil {
		t.Fatal(err)
	}
	if err := app.db.QueryRow(`SELECT runs_used FROM tasks LIMIT 1`).Scan(&budgetUsed); err != nil {
		t.Fatal(err)
	}
	if childCount != 1 || subThreadCount != 1 || budgetUsed != 1 {
		t.Fatalf("child/sub-thread/budget = %d/%d/%d", childCount, subThreadCount, budgetUsed)
	}
	var subMessages int
	if err := app.db.QueryRow(`SELECT count(*) FROM messages WHERE thread_id = (SELECT id FROM threads WHERE kind = 'sub' LIMIT 1)`).Scan(&subMessages); err != nil {
		t.Fatal(err)
	}
	if subMessages == 0 {
		t.Fatal("researcher sub-thread history was not persisted")
	}
	foundScratchpad := false
	_ = filepath.Walk(filepath.Join(dataDir, "scratchpad"), func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() && strings.HasSuffix(path, ".md") {
			foundScratchpad = true
		}
		return nil
	})
	if !foundScratchpad {
		t.Fatal("scratchpad markdown artifact not found")
	}

	if err := app.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened, err := newRuntimeApp(context.Background(), appConfig{
		bundle: bundle, dataDir: dataDir, auth: authConfig{mode: authModeNone}, providers: providers, mcpManager: stage2MCPManager(),
		validateMCPURL: func(string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Shutdown(context.Background()) })
	listed := httptest.NewRecorder()
	reopened.server.Handler.ServeHTTP(listed, httptest.NewRequest(http.MethodGet, "/v1/threads/"+thread.ID+"/messages", nil))
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), "Please research SQLite") || !strings.Contains(listed.Body.String(), "supervisor final answer") {
		t.Fatalf("reopened Stage 2 history status=%d body=%s", listed.Code, listed.Body.String())
	}
}

func TestRuntimeValidationPrecedesDataMutation(t *testing.T) {
	bundle := runtimeTestBundle(t)
	bundle.Agents[0].Provider = "missing"
	hash, err := bundle.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	bundle.ConfigHash = hash
	dataDir := filepath.Join(t.TempDir(), "must-not-exist")
	_, err = newRuntimeApp(context.Background(), appConfig{
		bundle: bundle, dataDir: dataDir, auth: authConfig{mode: authModeNone}, providers: llm.NewEmptyLLMRegistry(),
	})
	if err == nil || !strings.Contains(err.Error(), "provider") {
		t.Fatalf("newRuntimeApp error = %v", err)
	}
	if _, statErr := os.Stat(dataDir); !os.IsNotExist(statErr) {
		t.Fatalf("data directory was created before validation: %v", statErr)
	}
}

func TestRuntimeShutdownWaitsForTopLevelWorkerCleanup(t *testing.T) {
	bundle := runtimeTestBundle(t)
	bundle.Agents[0].Provider = "fake"
	bundle.Agents[0].Tools = []string{}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	bundle.ConfigHash = hash
	blocking := &shutdownBlockingLLM{
		entered: make(chan struct{}), canceled: make(chan struct{}), release: make(chan struct{}),
	}
	providers := llm.NewEmptyLLMRegistry()
	providers.Register("fake", blocking)
	dataDir := filepath.Join(t.TempDir(), "shutdown")
	app, err := newRuntimeApp(context.Background(), appConfig{
		bundle: bundle, dataDir: dataDir, auth: authConfig{mode: authModeNone}, providers: providers,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = app.Shutdown(context.Background())
	})

	created := httptest.NewRecorder()
	app.server.Handler.ServeHTTP(created, httptest.NewRequest(http.MethodPost, "/v1/threads", bytes.NewBufferString(`{"title":"Shutdown"}`)))
	var thread agent.ThreadRecord
	if err := json.Unmarshal(created.Body.Bytes(), &thread); err != nil {
		t.Fatal(err)
	}
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	sent := httptest.NewRecorder()
	handlerDone := make(chan struct{})
	go func() {
		defer close(handlerDone)
		req := httptest.NewRequest(http.MethodPost, "/v1/threads/"+thread.ID+"/messages", bytes.NewBufferString(`{"content":"block"}`)).WithContext(requestCtx)
		app.server.Handler.ServeHTTP(sent, req)
	}()
	select {
	case <-blocking.entered:
	case <-time.After(5 * time.Second):
		cancelRequest()
		close(blocking.release)
		t.Fatal("top-level worker did not reach the LLM")
	}
	cancelRequest() // models server.Close cancelling the in-flight HTTP request
	select {
	case <-blocking.canceled:
	case <-time.After(5 * time.Second):
		close(blocking.release)
		t.Fatal("worker context was not cancelled")
	}
	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- app.Shutdown(context.Background()) }()
	select {
	case err := <-shutdownDone:
		close(blocking.release)
		t.Fatalf("shutdown returned before worker cleanup was released: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(blocking.release)
	if err := <-shutdownDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-handlerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("message handler did not exit after shutdown")
	}

	db, err := sqliterepo.Open(filepath.Join(dataDir, "state.db"), sqliterepo.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var status string
	if err := db.QueryRow(`SELECT status FROM runs WHERE thread_id = ?`, thread.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "interrupted" {
		t.Fatalf("run status after clean shutdown = %q, want interrupted", status)
	}
}
