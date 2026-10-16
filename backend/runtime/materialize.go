package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"backend/deployment"
)

const (
	defaultBundleFetchTimeout = 30 * time.Second
	maxDeliveryTokenBytes     = 8 << 10
)

type materializeConfig struct {
	sourceURL          string
	tokenPath          string
	expectedConfigHash string
	outputPath         string
	client             *http.Client
}

func runMaterializeBundle(args []string) int {
	flags := flag.NewFlagSet("materialize-bundle", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	sourceURL := flags.String("url", "", "HTTPS URL for the immutable deployment bundle")
	tokenPath := flags.String("token-file", "", "path to the bundle-delivery bearer token")
	expectedHash := flags.String("expected-config-hash", "", "expected canonical bundle configuration hash")
	outputPath := flags.String("output", "", "absolute destination path for the verified bundle")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || *sourceURL == "" || *tokenPath == "" || *expectedHash == "" || *outputPath == "" {
		fmt.Fprintln(os.Stderr, "materialize-bundle: --url, --token-file, --expected-config-hash, and --output are required; positional arguments are not accepted")
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := &http.Client{
		Timeout: defaultBundleFetchTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if err := materializeBundle(ctx, materializeConfig{
		sourceURL: *sourceURL, tokenPath: *tokenPath, expectedConfigHash: *expectedHash,
		outputPath: *outputPath, client: client,
	}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func materializeBundle(ctx context.Context, cfg materializeConfig) error {
	if err := validateMaterializeConfig(cfg); err != nil {
		return err
	}
	token, err := readDeliveryToken(cfg.tokenPath)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.sourceURL, nil)
	if err != nil {
		return fmt.Errorf("materialize bundle: create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	client := *cfg.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("materialize bundle: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("materialize bundle: download returned HTTP status %d", resp.StatusCode)
	}
	if resp.ContentLength > deployment.MaxBundleBytes {
		return fmt.Errorf("materialize bundle: response exceeds %d bytes", deployment.MaxBundleBytes)
	}

	limited := io.LimitReader(resp.Body, deployment.MaxBundleBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("materialize bundle: read response: %w", err)
	}
	if len(raw) > deployment.MaxBundleBytes {
		return fmt.Errorf("materialize bundle: response exceeds %d bytes", deployment.MaxBundleBytes)
	}
	bundle, err := deployment.Parse(raw)
	if err != nil {
		return fmt.Errorf("materialize bundle: verify response: %w", err)
	}
	if bundle.ConfigHash != cfg.expectedConfigHash {
		return fmt.Errorf("materialize bundle: expected config hash %s, received %s", cfg.expectedConfigHash, bundle.ConfigHash)
	}
	if err := writeFileAtomically(cfg.outputPath, raw); err != nil {
		return fmt.Errorf("materialize bundle: persist verified response: %w", err)
	}
	return nil
}

func validateMaterializeConfig(cfg materializeConfig) error {
	parsed, err := url.ParseRequestURI(cfg.sourceURL)
	if err != nil {
		return fmt.Errorf("materialize bundle: invalid URL: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("materialize bundle: URL must be an absolute HTTPS URL without user information or a fragment")
	}
	if parsed.RawQuery != "" {
		return errors.New("materialize bundle: URL query parameters are not allowed")
	}
	if !validConfigHash(cfg.expectedConfigHash) {
		return errors.New("materialize bundle: expected config hash must be 64 lowercase hexadecimal characters")
	}
	if !filepath.IsAbs(cfg.tokenPath) {
		return errors.New("materialize bundle: token file path must be absolute")
	}
	if !filepath.IsAbs(cfg.outputPath) {
		return errors.New("materialize bundle: output path must be absolute")
	}
	if cfg.client == nil {
		return errors.New("materialize bundle: HTTP client is required")
	}
	return nil
}

func validConfigHash(hash string) bool {
	if len(hash) != 64 || strings.ToLower(hash) != hash {
		return false
	}
	decoded, err := hex.DecodeString(hash)
	return err == nil && len(decoded) == 32
}

func readDeliveryToken(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("materialize bundle: open token file: %w", err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxDeliveryTokenBytes+1))
	if err != nil {
		return "", fmt.Errorf("materialize bundle: read token file: %w", err)
	}
	if len(raw) == 0 || len(raw) > maxDeliveryTokenBytes {
		return "", fmt.Errorf("materialize bundle: token must contain between 1 and %d bytes", maxDeliveryTokenBytes)
	}
	token := string(raw)
	for i := 0; i < len(token); i++ {
		if token[i] <= ' ' || token[i] >= 0x7f {
			return "", errors.New("materialize bundle: token must contain visible ASCII without whitespace or control characters")
		}
	}
	return token, nil
}

func writeFileAtomically(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".agentflow-bundle-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tmpPath := tmp.Name()
	closed := false
	defer func() {
		if !closed {
			closeErr := tmp.Close()
			if closeErr != nil && err == nil {
				err = fmt.Errorf("close temporary file: %w", closeErr)
			}
		}
		if removeErr := os.Remove(tmpPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) && err == nil {
			err = fmt.Errorf("remove temporary file: %w", removeErr)
		}
	}()

	if err = tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("restrict temporary file permissions: %w", err)
	}
	if _, err = tmp.Write(data); err != nil {
		return fmt.Errorf("write temporary file: %w", err)
	}
	if err = tmp.Sync(); err != nil {
		return fmt.Errorf("sync temporary file: %w", err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	closed = true
	if err = os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace destination: %w", err)
	}
	directory, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open destination directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync destination directory: %w", err)
	}
	return nil
}
