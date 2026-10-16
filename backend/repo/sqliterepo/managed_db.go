package sqliterepo

import (
	"context"
	"database/sql"

	backenddb "backend/db"
)

const (
	sharedSchemaVersion    = 1
	executionSchemaVersion = 1
)

var (
	sharedMigrations    = []string{sharedMigrationV1}
	executionMigrations = []string{executionMigrationV1}
)

// OpenShared opens the deployment-wide managed store. It contains durable
// conversation and memory state, but no resumable execution state.
func OpenShared(path string, opts Options) (*sql.DB, error) {
	return openManaged(path, opts, sharedMigrations)
}

// OpenExecution opens one publication revision's managed execution store.
// A different revision must use a different database path.
func OpenExecution(path string, opts Options) (*sql.DB, error) {
	return openManaged(path, opts, executionMigrations)
}

func openManaged(path string, opts Options, steps []string) (*sql.DB, error) {
	db, err := backenddb.OpenSQLite(path, opts)
	if err != nil {
		return nil, err
	}
	if err := migrate(context.Background(), db, steps); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

const sharedMigrationV1 = `
CREATE TABLE deployment_storage_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    storage_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    runtime_principal_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE runtime_writer_fence (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    maximum_generation_seen INTEGER NOT NULL,
    active_generation INTEGER NOT NULL,
    active_revision INTEGER NOT NULL,
    active_config_hash TEXT NOT NULL,
    runtime_instance_id TEXT NOT NULL,
    started_at INTEGER NOT NULL
);

CREATE TABLE memory_meta (
    lineage_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    type TEXT NOT NULL,
    importance REAL NOT NULL,
    revision INTEGER NOT NULL,
    body_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    retired_at INTEGER,
    last_read_at INTEGER,
    deleted_at INTEGER,
    summary TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX memory_meta_user_unique ON memory_meta(user_id, scope, memory_id) WHERE scope = 'user';
CREATE UNIQUE INDEX memory_meta_agent_unique ON memory_meta(user_id, agent_id, scope, memory_id) WHERE scope = 'agent';
CREATE UNIQUE INDEX memory_meta_thread_unique ON memory_meta(user_id, agent_id, thread_id, scope, memory_id) WHERE scope = 'thread';
CREATE INDEX memory_meta_visibility_idx ON memory_meta(user_id, agent_id, thread_id, scope, expires_at, retired_at);

CREATE TABLE memory_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lineage_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    mutation_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    restored_from INTEGER,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    type TEXT NOT NULL,
    importance REAL NOT NULL,
    body_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    retired_at INTEGER,
    UNIQUE(lineage_key, revision)
);
CREATE INDEX memory_revisions_latest_idx ON memory_revisions(lineage_key, revision DESC);

CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    originator_run_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX threads_user_agent_idx ON threads(user_id, agent_id, created_at DESC);
CREATE UNIQUE INDEX sub_thread_unique ON threads(user_id, originator_run_id, agent_id) WHERE kind = 'sub';

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_call_id TEXT NOT NULL DEFAULT '',
    tool_calls_json TEXT,
    tool_name TEXT NOT NULL DEFAULT '',
    metadata_json TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX messages_thread_window_idx ON messages(thread_id, created_at DESC, id DESC);
`

const executionMigrationV1 = `
CREATE TABLE revision_execution_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    storage_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    config_hash TEXT NOT NULL,
    bundle_schema_version INTEGER NOT NULL CHECK(bundle_schema_version > 0),
    created_at INTEGER NOT NULL
);

CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    steps_completed INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    originator_run_id TEXT NOT NULL DEFAULT '',
    parent_run_id TEXT NOT NULL DEFAULT '',
    invocation_kind TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX runs_owner_idx ON runs(user_id, run_id);
CREATE INDEX runs_originator_idx ON runs(originator_run_id);

CREATE TABLE run_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT '',
    snapshot_gz BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
);
CREATE INDEX run_checkpoints_latest_idx ON run_checkpoints(run_id, step DESC, created_at DESC, id DESC);
CREATE INDEX run_checkpoints_expiry_idx ON run_checkpoints(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE tasks (
    originator_run_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    max_runs INTEGER NOT NULL,
    runs_used INTEGER NOT NULL DEFAULT 0,
    cancelled_at INTEGER,
    cancel_reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE task_run_keys (
    originator_run_id TEXT NOT NULL,
    budget_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(originator_run_id, budget_key),
    FOREIGN KEY(originator_run_id) REFERENCES tasks(originator_run_id) ON DELETE CASCADE
);

CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL,
    originator_run_id TEXT NOT NULL DEFAULT '',
    parent_thread_id TEXT NOT NULL DEFAULT '',
    parent_agent_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    delegate_tool TEXT NOT NULL DEFAULT '',
    target_agent_id TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT '',
    callback_instruction TEXT NOT NULL DEFAULT '',
    delegation_chain_json TEXT,
    delegation_depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    child_run_id TEXT NOT NULL DEFAULT '',
    child_thread_id TEXT NOT NULL DEFAULT '',
    awaiting_parent_run_id TEXT NOT NULL DEFAULT '',
    await_tool_call_id TEXT NOT NULL DEFAULT '',
    awaiting_since INTEGER,
    delivered_at INTEGER,
    delivered_tool_call_id TEXT NOT NULL DEFAULT '',
    callback_status TEXT NOT NULL DEFAULT 'none',
    callback_run_id TEXT NOT NULL DEFAULT '',
    callback_error TEXT NOT NULL DEFAULT '',
    lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE UNIQUE INDEX jobs_dispatch_key_unique ON jobs(parent_run_id, tool_call_id);
CREATE INDEX jobs_queue_idx ON jobs(status, lease_expires_at, created_at);
CREATE INDEX jobs_originator_status_idx ON jobs(originator_run_id, status);
CREATE INDEX jobs_awaiting_idx ON jobs(awaiting_parent_run_id, delivered_at);
CREATE INDEX jobs_callback_queue_idx ON jobs(mode, status, callback_status, finished_at);

CREATE TABLE job_locks (
    lock_key TEXT PRIMARY KEY,
    lock_type TEXT NOT NULL,
    active_job_id TEXT NOT NULL,
    active_run_id TEXT NOT NULL DEFAULT '',
    lease_owner TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
`
