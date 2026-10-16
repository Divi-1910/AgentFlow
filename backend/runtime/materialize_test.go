package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"backend/deployment"
)

func TestMaterializeBundleDownloadsVerifiesAndAtomicallyWrites(t *testing.T) {
	t.Parallel()
	raw, hash := materializeTestBundle(t)
	const token = "delivery-token"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	defer server.Close()

	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	outputPath := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := materializeBundle(context.Background(), materializeConfig{
		sourceURL: server.URL, tokenPath: tokenPath, expectedConfigHash: hash,
		outputPath: outputPath, client: server.Client(),
	}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, raw) {
		t.Fatal("materialized bytes differ from published bundle")
	}
	info, err := os.Stat(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if gotMode := info.Mode().Perm(); gotMode != 0o600 {
		t.Fatalf("bundle mode = %o, want 600", gotMode)
	}
}

func TestMaterializeBundlePreservesExistingBundleOnVerificationFailure(t *testing.T) {
	t.Parallel()
	raw, hash := materializeTestBundle(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(raw)
	}))
	defer server.Close()

	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	outputPath := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(tokenPath, []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	const previous = "previous verified bundle"
	if err := os.WriteFile(outputPath, []byte(previous), 0o600); err != nil {
		t.Fatal(err)
	}
	wrongHash := strings.Repeat("a", 64)
	if wrongHash == hash {
		wrongHash = strings.Repeat("b", 64)
	}
	err := materializeBundle(context.Background(), materializeConfig{
		sourceURL: server.URL, tokenPath: tokenPath, expectedConfigHash: wrongHash,
		outputPath: outputPath, client: server.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "expected config hash") {
		t.Fatalf("materializeBundle error = %v", err)
	}
	got, readErr := os.ReadFile(outputPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != previous {
		t.Fatalf("existing bundle changed to %q", got)
	}
}

func TestMaterializeBundleRejectsOversizedResponseBeforeWriting(t *testing.T) {
	t.Parallel()
	_, hash := materializeTestBundle(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(deployment.MaxBundleBytes+1))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	outputPath := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(tokenPath, []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := materializeBundle(context.Background(), materializeConfig{
		sourceURL: server.URL, tokenPath: tokenPath, expectedConfigHash: hash,
		outputPath: outputPath, client: server.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("materializeBundle error = %v", err)
	}
	if _, statErr := os.Stat(outputPath); !os.IsNotExist(statErr) {
		t.Fatalf("output exists after oversized response: %v", statErr)
	}
}

func TestMaterializeBundleRejectsOversizedStreamWithoutContentLength(t *testing.T) {
	t.Parallel()
	_, hash := materializeTestBundle(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Transfer-Encoding", "chunked")
		_, _ = io.CopyN(w, zeroReader{}, deployment.MaxBundleBytes+1)
	}))
	defer server.Close()

	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	outputPath := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(tokenPath, []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := materializeBundle(context.Background(), materializeConfig{
		sourceURL: server.URL, tokenPath: tokenPath, expectedConfigHash: hash,
		outputPath: outputPath, client: server.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("materializeBundle error = %v", err)
	}
	if _, statErr := os.Stat(outputPath); !os.IsNotExist(statErr) {
		t.Fatalf("output exists after oversized stream: %v", statErr)
	}
}

func TestMaterializeBundleDoesNotFollowRedirects(t *testing.T) {
	t.Parallel()
	_, hash := materializeTestBundle(t)
	var targetCalls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/target" {
			targetCalls.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/target", http.StatusTemporaryRedirect)
	}))
	defer server.Close()

	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenPath, []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := materializeBundle(context.Background(), materializeConfig{
		sourceURL: server.URL, tokenPath: tokenPath, expectedConfigHash: hash,
		outputPath: filepath.Join(dir, "bundle.json"), client: server.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "HTTP status 307") {
		t.Fatalf("materializeBundle error = %v", err)
	}
	if got := targetCalls.Load(); got != 0 {
		t.Fatalf("redirect target calls = %d, want 0", got)
	}
}

func TestMaterializeBundleRejectsInvalidBoundaryInputs(t *testing.T) {
	t.Parallel()
	validHash := strings.Repeat("a", 64)
	client := &http.Client{}
	tests := []struct {
		name string
		cfg  materializeConfig
	}{
		{name: "plain HTTP", cfg: materializeConfig{sourceURL: "http://control-plane/bundle", tokenPath: "/token", expectedConfigHash: validHash, outputPath: "/bundle.json", client: client}},
		{name: "URL query", cfg: materializeConfig{sourceURL: "https://control-plane/bundle?token=secret", tokenPath: "/token", expectedConfigHash: validHash, outputPath: "/bundle.json", client: client}},
		{name: "malformed hash", cfg: materializeConfig{sourceURL: "https://control-plane/bundle", tokenPath: "/token", expectedConfigHash: "bad", outputPath: "/bundle.json", client: client}},
		{name: "relative token path", cfg: materializeConfig{sourceURL: "https://control-plane/bundle", tokenPath: "token", expectedConfigHash: validHash, outputPath: "/bundle.json", client: client}},
		{name: "relative output path", cfg: materializeConfig{sourceURL: "https://control-plane/bundle", tokenPath: "/token", expectedConfigHash: validHash, outputPath: "bundle.json", client: client}},
		{name: "missing client", cfg: materializeConfig{sourceURL: "https://control-plane/bundle", tokenPath: "/token", expectedConfigHash: validHash, outputPath: "/bundle.json"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := validateMaterializeConfig(tc.cfg); err == nil {
				t.Fatal("validateMaterializeConfig succeeded")
			}
		})
	}
}

func TestReadDeliveryTokenRejectsWhitespace(t *testing.T) {
	t.Parallel()
	for _, token := range []string{"token\n", "token value", "token\x00value"} {
		token := token
		t.Run(strconv.QuoteToASCII(token), func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readDeliveryToken(path); err == nil || !strings.Contains(err.Error(), "whitespace") {
				t.Fatalf("readDeliveryToken error = %v", err)
			}
		})
	}
}

func materializeTestBundle(t *testing.T) ([]byte, string) {
	t.Helper()
	bundle := deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion,
		DeploymentID:  "deployment-test",
		RootAgentID:   "root",
		PlatformXML:   "<platform>test</platform>",
		Agents: []deployment.BundleAgent{{
			ID: "root", Name: "Root", Provider: "openai", Model: "gpt-4o", SystemPrompt: "help",
			Tools: []string{}, Delegates: []deployment.BundleDelegate{}, MCPServers: []deployment.BundleMCPServer{},
			ModelContextLimit: 128000, ContextWindow: 6000, ContextKeepRatio: 0.5,
			SummarizationModel: "gpt-4o", MaxSteps: 25, Temperature: 0.7, MaxTokens: 1000, MaxRuns: 10,
		}},
	}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	bundle.ConfigHash = hash
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	return raw, hash
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
