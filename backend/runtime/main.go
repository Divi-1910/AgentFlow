package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"backend/deployment"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: agentflow-runtime <serve|hash-config|materialize-bundle|migrate-storage> [flags]")
		return 2
	}
	switch args[0] {
	case "hash-config":
		return runHashConfig(args[1:])
	case "materialize-bundle":
		return runMaterializeBundle(args[1:])
	case "serve":
		return runServe(args[1:])
	case "migrate-storage":
		return runMigrateStorage(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		return 2
	}
}

func runMigrateStorage(args []string) int {
	flags := flag.NewFlagSet("migrate-storage", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	dataDir := flags.String("data", "", "offline legacy runtime data directory")
	storageID := flags.String("storage-id", "", "stable managed storage identity")
	deploymentID := flags.String("deployment-id", "", "logical deployment identity")
	configHash := flags.String("config-hash", "", "legacy combined database configuration hash")
	schemaVersion := flags.Int("bundle-schema-version", 0, "bundle schema version")
	apply := flags.Bool("apply", false, "execute the planned forward migration")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	plan, err := migrateLegacyStorage(ctx, storageMigrationRequest{
		DataDir: *dataDir, StorageID: *storageID, DeploymentID: *deploymentID,
		ConfigHash: *configHash, SchemaVersion: *schemaVersion,
	}, *apply)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	response := struct {
		DryRun   bool                 `json:"dry_run"`
		Applied  bool                 `json:"applied"`
		Verified bool                 `json:"verified"`
		Plan     storageMigrationPlan `json:"plan"`
	}{DryRun: !*apply, Applied: *apply, Verified: *apply && plan.Completed, Plan: plan}
	if err := json.NewEncoder(os.Stdout).Encode(response); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func runHashConfig(args []string) int {
	flags := flag.NewFlagSet("hash-config", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "path to deployment JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "hash-config: --config is required")
		return 2
	}
	bundle, err := deployment.Read(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Fprintln(os.Stdout, hash)
	return 0
}

func runServe(args []string) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "path to deployment JSON")
	dataDir := flags.String("data", "", "runtime data directory")
	listenAddr := flags.String("listen", ":9090", "HTTP listen address")
	managedStorage := flags.Bool("managed-storage", false, "use AgentFlow-managed revision storage")
	storageID := flags.String("storage-id", "", "controller-supplied managed storage identity")
	deploymentID := flags.String("deployment-id", "", "controller-supplied deployment identity")
	revision := flags.Int("revision", 0, "controller-supplied publication revision")
	generation := flags.Int64("generation", 0, "controller-supplied deployment generation")
	expectedConfigHash := flags.String("expected-config-hash", "", "controller-supplied canonical config hash")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" || *dataDir == "" {
		fmt.Fprintln(os.Stderr, "serve: --config and --data are required")
		return 2
	}
	bundle, err := deployment.Load(*configPath)
	if err != nil {
		slog.Error("deployment bundle rejected", "error", err)
		return 1
	}
	auth, err := loadAuthConfig(os.Getenv)
	if err != nil {
		slog.Error("runtime auth configuration rejected", "error", err)
		return 1
	}
	logAuthMode(slog.Default(), auth)
	storageContext, err := managedStorageContextFromFlags(
		*managedStorage,
		*storageID,
		*deploymentID,
		*revision,
		*generation,
		*expectedConfigHash,
	)
	if err != nil {
		slog.Error("runtime managed storage configuration rejected", "error", err)
		return 1
	}

	runtimeCtx, cancelRuntime := context.WithCancel(context.Background())
	app, err := newRuntimeApp(runtimeCtx, appConfig{
		bundle: bundle, dataDir: *dataDir, listenAddr: *listenAddr, auth: auth, logger: slog.Default(),
		managedStorage: storageContext,
	})
	if err != nil {
		cancelRuntime()
		slog.Error("runtime startup failed", "error", err)
		return 1
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- app.Serve() }()
	slog.Info("agentflow runtime listening", "addr", *listenAddr, "deployment_id", bundle.DeploymentID, "config_hash", bundle.ConfigHash)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case sig := <-signals:
		slog.Info("runtime shutdown requested", "signal", sig.String())
	case err := <-serveErr:
		if err != nil {
			slog.Error("runtime server failed", "error", err)
			cancelRuntime()
			_ = app.closeResources(context.Background())
			return 1
		}
	}
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelShutdown()
	if err := app.Shutdown(shutdownCtx); err != nil {
		slog.Error("runtime shutdown failed", "error", err)
		cancelRuntime()
		return 1
	}
	cancelRuntime()
	return 0
}

func managedStorageContextFromFlags(
	isManaged bool,
	storageID string,
	deploymentID string,
	revision int,
	generation int64,
	expectedConfigHash string,
) (*managedStorageContext, error) {
	hasManagedValue := storageID != "" || deploymentID != "" || revision != 0 || generation != 0 || expectedConfigHash != ""
	if !isManaged {
		if hasManagedValue {
			return nil, fmt.Errorf("serve: managed storage values require --managed-storage")
		}
		return nil, nil
	}
	return &managedStorageContext{
		storageID:          storageID,
		deploymentID:       deploymentID,
		revision:           revision,
		generation:         generation,
		expectedConfigHash: expectedConfigHash,
	}, nil
}
