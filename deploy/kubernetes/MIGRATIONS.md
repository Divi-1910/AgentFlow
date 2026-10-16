# Deployment-state migration runbook

Deployment-state migrations are never executed during backend startup and are
never triggered by a normal API read. Each invocation targets exactly one
owner and one deployment. Without `--apply`, the command performs a real
read-only dry run: it verifies the source record and immutable publication and
prints the exact planned transition.

Build the operator command:

```sh
cd backend
go build -o deployment-migrate ./cmd/deployment-migrate
```

The command requires `MONGO_URL`; unlike the Studio server, it deliberately has
no localhost fallback.

## Legacy flat state to version 3

First back up the source collections. Keep the dump until post-migration
verification and at least one successful deployment:

```sh
mongodump --uri "$MONGO_URL" --db AgentFlow \
  --collection deployment_states --out ./agentflow-pre-migration
mongodump --uri "$MONGO_URL" --db AgentFlow \
  --collection deployment_revisions --out ./agentflow-pre-migration
```

Run the command once without `--apply`:

```sh
MONGO_URL='mongodb://…' ./deployment-migrate \
  --kind legacy \
  --user-id OWNER_OBJECT_ID \
  --deployment-id DEPLOYMENT_ID \
  --revision 7 \
  --namespace agentflow-runtimes \
  --runtime-image 'registry.example/agentflow-runtime@sha256:…' \
  --legacy-resource-name OLD_KUBERNETES_NAME
```

Review `dry_run`, the record versions, revision, hash, namespace, image, and
resulting storage phase. Repeat the identical command with `--apply` only after
the plan is correct.

The tool loads the owner-scoped immutable publication and derives its hash and
schema itself. It then uses a compare-and-set filter that also checks the old
revision, hash, and optional resource name. If the source changed or was
already migrated, the write fails with a conflict.

## Version 2 to version 3

```sh
MONGO_URL='mongodb://…' ./deployment-migrate \
  --kind v2 \
  --user-id OWNER_OBJECT_ID \
  --deployment-id DEPLOYMENT_ID
```

Again, the first run is read-only. Add `--apply` to the same command to execute
it. The apply path immediately reloads the migrated record and verifies its
version, owner/deployment identity, desired target, storage phase, and retained
legacy-PVC evidence. Output reports `applied: true` and `verified: true` only
after that verification succeeds.

If the version-2 record references a PVC, the result becomes
`storage_migration_required`. The controller will not guess that the old claim
is the new stable claim and will not provision over it. Moving or adopting old
PVC data is an operator-controlled data migration; verify the source claim,
copy and validate its data into the stable claim before allowing
reconciliation. Fresh version-3 deployments do not require this path.

## Legacy combined runtime storage to managed split storage

The runtime image includes a separate offline command. Scale the old runtime
to zero first; no process may have `state.db` or its files open. Mount the PVC
at `/var/lib/agentflow` in a one-off operator Job and run a dry run:

```sh
agentflow-runtime migrate-storage \
  --data /var/lib/agentflow \
  --storage-id STABLE_STORAGE_SHA256 \
  --deployment-id DEPLOYMENT_ID \
  --config-hash LEGACY_CONFIG_SHA256 \
  --bundle-schema-version 1
```

The dry run verifies:

- the legacy SQLite file is regular and exactly schema version 3;
- `PRAGMA integrity_check` succeeds;
- stored deployment/configuration identity matches the supplied values;
- every expected source table exists and its row count is recorded; and
- memory and scratchpad trees contain no symlinks or unsupported file types.

Repeat with `--apply` to execute. The migration:

1. copies shared conversation and memory tables into `shared/shared.db`;
2. copies ambiguous legacy execution tables into a non-runnable
   `revisions/legacy-v3-<hash>/execution.db` quarantine;
3. copies memory and scratchpad files into their corresponding managed paths;
4. verifies both new databases, every table count, file count, and stable
   storage identity;
5. atomically installs the staged directories;
6. moves the original database, WAL/SHM files, memory, and scratchpad trees
   under `/var/lib/agentflow/legacy` as the on-volume backup; and
7. writes `deployment-meta/layout.json` last.

The phase manifest is replayable. If the Job stops after staging or during
installation, rerun the identical `--apply` command. It completes the forward
renames and verification. It never boots old code against a partially split
layout and never attempts an automatic rollback. A completed rerun is also
idempotent and re-verifies the installed layout.

After success, preserve a volume snapshot in addition to the on-volume
`legacy` backup. Confirm the command reports `verified: true`, then inspect the
quarantined execution state as historical data only; it is deliberately not
resumable because the old database did not prove which publication revision
created each in-flight run.

## Failure recovery

- A dry-run failure writes nothing; correct the inputs or source corruption.
- A compare-and-set conflict means the MongoDB source changed or was already
  migrated. Re-run the dry run and do not force the old plan.
- A storage migration failure before `layout.json` is repaired by rerunning the
  same `--apply` command after correcting the reported disk or data problem.
- If post-write MongoDB verification fails, stop reconciliation, retain the
  database dump, inspect the single owner/deployment document, and make a new
  forward corrective migration. Do not restore only one collection over live
  writes.
- Never delete the `legacy` directory or pre-migration snapshots until the new
  runtime has started, accepted a proxied request, and read the expected memory
  and scratchpad data.

The supported recovery model is continued or corrective forward migration,
not automatic rollback of deployment history.
