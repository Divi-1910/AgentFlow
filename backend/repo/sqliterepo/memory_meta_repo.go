package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"backend/memory"
	"backend/runtimectx"
)

type MemoryMetaRepo struct{ db *sql.DB }

func NewMemoryMetaRepo(db *sql.DB) *MemoryMetaRepo { return &MemoryMetaRepo{db: db} }

func (r *MemoryMetaRepo) Upsert(ctx context.Context, doc memory.MemoryDocument) error {
	normalized, err := normalizeMemoryDocument(doc)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
INSERT INTO memory_meta(
    lineage_key, user_id, agent_id, thread_id, memory_id, scope, type, importance,
    revision, body_path, created_at, updated_at, expires_at, retired_at, last_read_at,
    deleted_at, summary)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
ON CONFLICT(lineage_key) DO UPDATE SET
    user_id=excluded.user_id, agent_id=excluded.agent_id, thread_id=excluded.thread_id,
    memory_id=excluded.memory_id, scope=excluded.scope, type=excluded.type,
    importance=excluded.importance, revision=excluded.revision, body_path=excluded.body_path,
    created_at=excluded.created_at, updated_at=excluded.updated_at,
    expires_at=excluded.expires_at, retired_at=excluded.retired_at,
    deleted_at=NULL, summary=excluded.summary
WHERE memory_meta.revision <= excluded.revision`,
		normalized.LineageKey, normalized.UserID, normalized.AgentID, normalized.ThreadID,
		normalized.ID, normalized.Scope, normalized.Type, normalized.Importance,
		normalized.Revision, normalized.BodyPath, unixNano(normalized.CreatedAt), unixNano(normalized.UpdatedAt),
		nullableUnixNano(normalized.ExpiresAt), nullableUnixNano(normalized.RetiredAt),
		nil, normalized.Summary)
	if err != nil {
		if isConstraint(err) {
			// Mongo's duplicate-key recovery retries by lineage without upsert;
			// an identity occupied by another lineage therefore becomes a no-op.
			return nil
		}
		return fmt.Errorf("memory_meta_repo: upsert projection: %w", err)
	}
	return nil
}

func normalizeMemoryDocument(doc memory.MemoryDocument) (memory.MemoryDocument, error) {
	if doc.LineageKey == "" {
		key, err := memory.LineageKey(runtimectx.MemoryScope{
			UserID: doc.UserID, AgentID: doc.AgentID, ThreadID: doc.ThreadID,
		}, doc.Scope, doc.ID)
		if err != nil {
			return memory.MemoryDocument{}, fmt.Errorf("memory_meta_repo: lineage key: %w", err)
		}
		doc.LineageKey = key
	}
	if doc.Revision <= 0 {
		doc.Revision = 1
	}
	if doc.UpdatedAt.IsZero() {
		doc.UpdatedAt = doc.CreatedAt
	}
	if doc.UpdatedAt.IsZero() {
		doc.UpdatedAt = time.Now().UTC()
	}
	return doc, nil
}

func (r *MemoryMetaRepo) FindActive(ctx context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, includeRetired bool, now time.Time) ([]memory.MemoryDocument, error) {
	visibility, args, ok := memoryVisibility(execScope, searchScope)
	if !ok {
		return nil, fmt.Errorf("memory_meta_repo: unknown search scope %q", searchScope)
	}
	query := `SELECT ` + memoryMetaColumns + ` FROM memory_meta WHERE (` + visibility + `)
AND (expires_at IS NULL OR expires_at > ?) AND deleted_at IS NULL`
	args = append(args, unixNano(now))
	if !includeRetired {
		query += ` AND retired_at IS NULL`
	}
	if typeFilter != nil {
		query += ` AND type = ?`
		args = append(args, *typeFilter)
	}
	query += ` LIMIT ?`
	args = append(args, memory.MaxScannedFiles)
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("memory_meta_repo: find active: %w", err)
	}
	defer rows.Close()
	return scanMemoryDocuments(rows, "active")
}

func memoryVisibility(scope runtimectx.MemoryScope, searchScope string) (string, []any, bool) {
	thread := `(scope = 'thread' AND user_id = ? AND agent_id = ? AND thread_id = ?)`
	agentScope := `(scope = 'agent' AND user_id = ? AND agent_id = ?)`
	user := `(scope = 'user' AND user_id = ?)`
	switch searchScope {
	case memory.ScopeThread:
		return thread, []any{scope.UserID, scope.AgentID, scope.ThreadID}, true
	case memory.ScopeAgent:
		return agentScope + ` OR ` + thread, []any{
			scope.UserID, scope.AgentID,
			scope.UserID, scope.AgentID, scope.ThreadID,
		}, true
	case memory.ScopeUser:
		return user + ` OR ` + agentScope + ` OR ` + thread, []any{
			scope.UserID,
			scope.UserID, scope.AgentID,
			scope.UserID, scope.AgentID, scope.ThreadID,
		}, true
	default:
		return "", nil, false
	}
}

func (r *MemoryMetaRepo) StampRead(ctx context.Context, doc memory.MemoryDocument) error {
	var (
		query string
		args  []any
	)
	if doc.LineageKey != "" {
		query = `UPDATE memory_meta SET last_read_at = ? WHERE lineage_key = ?`
		args = []any{unixNano(time.Now()), doc.LineageKey}
	} else {
		query = `UPDATE memory_meta SET last_read_at = ? WHERE agent_id = ? AND scope = ? AND memory_id = ?`
		args = []any{unixNano(time.Now()), doc.AgentID, doc.Scope, doc.ID}
	}
	if _, err := r.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("memory_meta_repo: stamp read: %w", err)
	}
	return nil
}

func (r *MemoryMetaRepo) FindExpired(ctx context.Context, now time.Time) ([]memory.MemoryDocument, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+memoryMetaColumns+` FROM memory_meta
WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL LIMIT ?`,
		unixNano(now), memory.MaxScannedFiles)
	if err != nil {
		return nil, fmt.Errorf("memory_meta_repo: find expired: %w", err)
	}
	defer rows.Close()
	return scanMemoryDocuments(rows, "expired")
}

func (r *MemoryMetaRepo) SoftDelete(ctx context.Context, agentID, scope, memoryID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE memory_meta SET deleted_at = ? WHERE agent_id = ? AND scope = ? AND memory_id = ?`,
		unixNano(time.Now()), agentID, scope, memoryID)
	if err != nil {
		return fmt.Errorf("memory_meta_repo: soft delete: %w", err)
	}
	return nil
}

const memoryMetaColumns = `lineage_key, user_id, agent_id, thread_id, memory_id,
scope, type, importance, revision, body_path, created_at, updated_at, expires_at,
retired_at, last_read_at, deleted_at, summary`

func scanMemoryDocument(s rowScanner) (memory.MemoryDocument, error) {
	var (
		doc                              memory.MemoryDocument
		createdAt, updatedAt             int64
		expiresAt, retiredAt, lastReadAt sql.NullInt64
		deletedAt                        sql.NullInt64
	)
	err := s.Scan(
		&doc.LineageKey, &doc.UserID, &doc.AgentID, &doc.ThreadID, &doc.ID,
		&doc.Scope, &doc.Type, &doc.Importance, &doc.Revision, &doc.BodyPath,
		&createdAt, &updatedAt, &expiresAt, &retiredAt, &lastReadAt, &deletedAt, &doc.Summary,
	)
	if err != nil {
		return memory.MemoryDocument{}, err
	}
	doc.CreatedAt = timeFromUnixNano(createdAt)
	doc.UpdatedAt = timeFromUnixNano(updatedAt)
	doc.ExpiresAt = timeFromNull(expiresAt)
	doc.RetiredAt = timeFromNull(retiredAt)
	doc.LastReadAt = timeFromNull(lastReadAt)
	return doc, nil
}

func scanMemoryDocuments(rows *sql.Rows, label string) ([]memory.MemoryDocument, error) {
	var docs []memory.MemoryDocument
	for rows.Next() {
		doc, err := scanMemoryDocument(rows)
		if err != nil {
			return nil, fmt.Errorf("memory_meta_repo: decode %s: %w", label, err)
		}
		docs = append(docs, doc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("memory_meta_repo: iterate %s: %w", label, err)
	}
	return docs, nil
}
