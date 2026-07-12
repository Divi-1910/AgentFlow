package main

import (
	"context"
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
		fmt.Fprintln(os.Stderr, "usage: agentflow-runtime <serve|hash-config> [flags]")
		return 2
	}
	switch args[0] {
	case "hash-config":
		return runHashConfig(args[1:])
	case "serve":
		return runServe(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		return 2
	}
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

	runtimeCtx, cancelRuntime := context.WithCancel(context.Background())
	app, err := newRuntimeApp(runtimeCtx, appConfig{
		bundle: bundle, dataDir: *dataDir, listenAddr: *listenAddr, auth: auth, logger: slog.Default(),
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
