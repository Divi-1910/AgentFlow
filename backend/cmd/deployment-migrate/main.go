package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	deploymentmigration "backend/deployment/migration"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type arguments struct {
	kind               string
	database           string
	userID             string
	deploymentID       string
	revision           int
	namespace          string
	runtimeImage       string
	legacyResourceName string
	apply              bool
}

type output struct {
	DryRun   bool                     `json:"dry_run"`
	Applied  bool                     `json:"applied"`
	Verified bool                     `json:"verified"`
	Plan     deploymentmigration.Plan `json:"plan"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "deployment migration failed:", err)
		os.Exit(1)
	}
}

func run() error {
	var args arguments
	flag.StringVar(&args.kind, "kind", "", "migration kind: legacy or v2")
	flag.StringVar(&args.database, "database", "AgentFlow", "MongoDB database name")
	flag.StringVar(&args.userID, "user-id", "", "owning user ObjectID")
	flag.StringVar(&args.deploymentID, "deployment-id", "", "deployment ID")
	flag.IntVar(&args.revision, "revision", 0, "owned immutable publication revision (legacy only)")
	flag.StringVar(&args.namespace, "namespace", "", "managed runtime namespace (legacy only)")
	flag.StringVar(&args.runtimeImage, "runtime-image", "", "digest-pinned runtime image (legacy only)")
	flag.StringVar(&args.legacyResourceName, "legacy-resource-name", "", "expected old Kubernetes resource name (legacy only)")
	flag.BoolVar(&args.apply, "apply", false, "perform the single-record migration")
	flag.Parse()

	if args.kind != "legacy" && args.kind != "v2" {
		return errors.New("--kind must be legacy or v2")
	}
	if strings.TrimSpace(args.userID) == "" || strings.TrimSpace(args.deploymentID) == "" {
		return errors.New("--user-id and --deployment-id are required")
	}
	mongoURL := strings.TrimSpace(os.Getenv("MONGO_URL"))
	if mongoURL == "" {
		return errors.New("MONGO_URL is required; no localhost default is used by this operator command")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	connectCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI(mongoURL))
	if err != nil {
		return fmt.Errorf("connect MongoDB: %w", err)
	}
	defer client.Disconnect(context.Background())
	if err := client.Ping(connectCtx, nil); err != nil {
		return fmt.Errorf("ping MongoDB: %w", err)
	}

	database := client.Database(args.database)
	states := mongorepo.NewDeploymentStateRepo(database.Collection("deployment_states"))
	revisions := mongorepo.NewDeploymentRevisionRepo(database.Collection("deployment_revisions"))
	service, err := deploymentmigration.NewService(states, revisions, nil)
	if err != nil {
		return err
	}
	var plan deploymentmigration.Plan
	switch args.kind {
	case "legacy":
		request := deploymentmigration.LegacyRequest{
			UserID: args.userID, DeploymentID: args.deploymentID, Revision: args.revision,
			Namespace: args.namespace, RuntimeImage: args.runtimeImage,
			LegacyResourceName: args.legacyResourceName,
		}
		plan, err = service.PlanLegacy(ctx, request)
		if err == nil && args.apply {
			_, err = service.MigrateLegacy(ctx, request)
		}
	case "v2":
		plan, err = service.PlanV2(ctx, args.userID, args.deploymentID)
		if err == nil && args.apply {
			_, err = service.MigrateV2(ctx, args.userID, args.deploymentID)
		}
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(output{
		DryRun: !args.apply, Applied: args.apply, Verified: args.apply, Plan: plan,
	})
}
