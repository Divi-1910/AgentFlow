package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"

	backenddb "backend/db"
)

const schemaVersion = 1

type Options = backenddb.SQLiteOptions

func Open(path string, opts Options) (*sql.DB, error) {
	db, err := backenddb.OpenSQLite(path, opts)
	if err != nil {
		return nil, err
	}
	if err := Migrate(context.Background(), db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func Migrate(ctx context.Context, db *sql.DB) error {
	return migrate(ctx, db, migrations)
}

var migrations = []string{migrationV1}

func migrate(ctx context.Context, db *sql.DB, steps []string) error {
	var current int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("sqliterepo: read schema version: %w", err)
	}
	if current > len(steps) {
		return fmt.Errorf("sqliterepo: database schema version %d is newer than supported version %d", current, len(steps))
	}
	for current < len(steps) {
		next := current + 1
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("sqliterepo: begin migration %d: %w", next, err)
		}
		if _, err = tx.ExecContext(ctx, steps[current]); err == nil {
			_, err = tx.ExecContext(ctx, "PRAGMA user_version = "+strconv.Itoa(next))
		}
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("sqliterepo: migration %d: %w", next, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("sqliterepo: commit migration %d: %w", next, err)
		}
		current = next
	}
	return nil
}

const migrationV1 = `
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
