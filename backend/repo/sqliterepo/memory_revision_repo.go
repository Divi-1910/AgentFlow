package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"

	"backend/memory"
)

type MemoryRevisionRepo struct{ db *sql.DB }

func NewMemoryRevisionRepo(db *sql.DB) *MemoryRevisionRepo { return &MemoryRevisionRepo{db: db} }

func (r *MemoryRevisionRepo) Append(ctx context.Context, rev memory.MemoryRevision) (*memory.MemoryRevision, bool, error) {
	_, err := r.db.ExecContext(ctx, `
INSERT INTO memory_revisions(
    lineage_key, revision, mutation_id, run_id, tool_call_id, operation, reason,
    restored_from, user_id, agent_id, thread_id, memory_id, scope, type, importance,
    body_path, created_at, updated_at, expires_at, retired_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rev.LineageKey, rev.Revision, rev.MutationID, rev.RunID, rev.ToolCallID,
		rev.Operation, rev.Reason, nullableInt(rev.RestoredFrom), rev.UserID, rev.AgentID,
		rev.ThreadID, rev.MemoryID, rev.Scope, rev.Type, rev.Importance, rev.BodyPath,
		unixNano(rev.CreatedAt), unixNano(rev.UpdatedAt), nullableUnixNano(rev.ExpiresAt),
		nullableUnixNano(rev.RetiredAt))
	if err == nil {
		cp := rev
		return &cp, false, nil
	}
	if !isConstraint(err) {
		return nil, false, fmt.Errorf("memory_revision_repo: append: %w", err)
	}
	existing, findErr := r.FindByMutation(ctx, rev.MutationID)
	if findErr != nil {
		return nil, false, findErr
	}
	if existing != nil && existing.LineageKey == rev.LineageKey {
		return existing, true, nil
	}
	return nil, false, memory.ErrRevisionConflict
}

func nullableInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func (r *MemoryRevisionRepo) FindByMutation(ctx context.Context, mutationID string) (*memory.MemoryRevision, error) {
	return r.findOne(ctx, `SELECT `+memoryRevisionColumns+` FROM memory_revisions WHERE mutation_id = ?`, mutationID)
}

func (r *MemoryRevisionRepo) Latest(ctx context.Context, lineageKey string) (*memory.MemoryRevision, error) {
	return r.findOne(ctx, `SELECT `+memoryRevisionColumns+` FROM memory_revisions
WHERE lineage_key = ? ORDER BY revision DESC LIMIT 1`, lineageKey)
}

func (r *MemoryRevisionRepo) FindRevision(ctx context.Context, lineageKey string, revision int) (*memory.MemoryRevision, error) {
	return r.findOne(ctx, `SELECT `+memoryRevisionColumns+` FROM memory_revisions
WHERE lineage_key = ? AND revision = ?`, lineageKey, revision)
}

func (r *MemoryRevisionRepo) List(ctx context.Context, lineageKey string) ([]memory.MemoryRevision, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+memoryRevisionColumns+` FROM memory_revisions
WHERE lineage_key = ? ORDER BY revision ASC`, lineageKey)
	if err != nil {
		return nil, fmt.Errorf("memory_revision_repo: list: %w", err)
	}
	defer rows.Close()
	var revisions []memory.MemoryRevision
	for rows.Next() {
		rev, err := scanMemoryRevision(rows)
		if err != nil {
			return nil, fmt.Errorf("memory_revision_repo: decode list: %w", err)
		}
		revisions = append(revisions, rev)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("memory_revision_repo: iterate list: %w", err)
	}
	return revisions, nil
}

func (r *MemoryRevisionRepo) findOne(ctx context.Context, query string, args ...any) (*memory.MemoryRevision, error) {
	rev, err := scanMemoryRevision(r.db.QueryRowContext(ctx, query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("memory_revision_repo: find: %w", err)
	}
	return &rev, nil
}

const memoryRevisionColumns = `lineage_key, revision, mutation_id, run_id, tool_call_id,
operation, reason, restored_from, user_id, agent_id, thread_id, memory_id, scope, type,
importance, body_path, created_at, updated_at, expires_at, retired_at`

func scanMemoryRevision(s rowScanner) (memory.MemoryRevision, error) {
	var (
		rev                  memory.MemoryRevision
		restoredFrom         sql.NullInt64
		createdAt, updatedAt int64
		expiresAt, retiredAt sql.NullInt64
	)
	err := s.Scan(
		&rev.LineageKey, &rev.Revision, &rev.MutationID, &rev.RunID, &rev.ToolCallID,
		&rev.Operation, &rev.Reason, &restoredFrom, &rev.UserID, &rev.AgentID,
		&rev.ThreadID, &rev.MemoryID, &rev.Scope, &rev.Type, &rev.Importance,
		&rev.BodyPath, &createdAt, &updatedAt, &expiresAt, &retiredAt,
	)
	if err != nil {
		return memory.MemoryRevision{}, err
	}
	if restoredFrom.Valid {
		v := int(restoredFrom.Int64)
		rev.RestoredFrom = &v
	}
	rev.CreatedAt = timeFromUnixNano(createdAt)
	rev.UpdatedAt = timeFromUnixNano(updatedAt)
	rev.ExpiresAt = timeFromNull(expiresAt)
	rev.RetiredAt = timeFromNull(retiredAt)
	return rev, nil
}
