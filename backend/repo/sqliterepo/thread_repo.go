package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"backend/agent"

	"github.com/google/uuid"
)

type ThreadRepo struct{ db *sql.DB }

func NewThreadRepo(db *sql.DB) *ThreadRepo { return &ThreadRepo{db: db} }

func (r *ThreadRepo) Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error) {
	if title == "" {
		title = "New Thread"
	}
	now := time.Now().UTC()
	record := &agent.ThreadRecord{
		ID: uuid.NewString(), UserID: userID, AgentID: agentID, Title: title,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, err := r.db.ExecContext(ctx, `
INSERT INTO threads(id, user_id, agent_id, kind, originator_run_id, title, summary,
                    metadata_json, created_at, updated_at)
VALUES(?, ?, ?, '', '', ?, '', NULL, ?, ?)`, record.ID, userID, agentID, title, unixNano(now), unixNano(now)); err != nil {
		return nil, fmt.Errorf("thread_repo: insert failed: %w", err)
	}
	return record, nil
}

func (r *ThreadRepo) GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error) {
	record, err := scanThread(r.db.QueryRowContext(ctx, `SELECT `+threadColumns+` FROM threads WHERE id = ? AND user_id = ?`, threadID, userID))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("thread not found")
	}
	if err != nil {
		return nil, fmt.Errorf("thread_repo: find failed: %w", err)
	}
	return record, nil
}

func (r *ThreadRepo) ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+threadColumns+` FROM threads
WHERE agent_id = ? AND user_id = ? AND kind <> 'sub'
ORDER BY created_at DESC, id DESC`, agentID, userID)
	if err != nil {
		return nil, fmt.Errorf("thread_repo: find failed: %w", err)
	}
	defer rows.Close()
	var records []*agent.ThreadRecord
	for rows.Next() {
		record, err := scanThread(rows)
		if err != nil {
			return nil, fmt.Errorf("thread_repo: decode failed: %w", err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread_repo: iterate failed: %w", err)
	}
	return records, nil
}

// FindOrCreateSubThread keeps insert and read in one IMMEDIATE transaction.
// Losing concurrent inserts do nothing, then all callers select the same row;
// the winner's original timestamps remain unchanged.
func (r *ThreadRepo) FindOrCreateSubThread(ctx context.Context, userID, originatorRunID, agentID string) (string, error) {
	if originatorRunID == "" {
		return "", fmt.Errorf("thread_repo: originator_run_id is required for a sub-thread")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("thread_repo: begin find-or-create sub-thread: %w", err)
	}
	defer tx.Rollback()
	now := unixNano(time.Now())
	if _, err := tx.ExecContext(ctx, `
INSERT INTO threads(id, user_id, agent_id, kind, originator_run_id, title, summary,
                    metadata_json, created_at, updated_at)
VALUES(?, ?, ?, 'sub', ?, 'delegation', '', NULL, ?, ?)
ON CONFLICT DO NOTHING`, uuid.NewString(), userID, agentID, originatorRunID, now, now); err != nil {
		return "", fmt.Errorf("thread_repo: insert sub-thread: %w", err)
	}
	var id string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM threads
WHERE user_id = ? AND originator_run_id = ? AND agent_id = ? AND kind = 'sub'`,
		userID, originatorRunID, agentID).Scan(&id); err != nil {
		return "", fmt.Errorf("thread_repo: select sub-thread: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("thread_repo: commit sub-thread: %w", err)
	}
	return id, nil
}

func (r *ThreadRepo) UpdateSummary(ctx context.Context, threadID, userID, summary string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE threads SET summary = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
		summary, unixNano(time.Now()), threadID, userID)
	if err != nil {
		return fmt.Errorf("thread_repo: update summary failed: %w", err)
	}
	return nil
}

const threadColumns = `id, user_id, agent_id, kind, originator_run_id, title,
summary, metadata_json, created_at, updated_at`

func scanThread(s rowScanner) (*agent.ThreadRecord, error) {
	var (
		record               agent.ThreadRecord
		metadata             sql.NullString
		createdAt, updatedAt int64
	)
	err := s.Scan(&record.ID, &record.UserID, &record.AgentID, &record.Kind,
		&record.OriginatorRunID, &record.Title, &record.Summary, &metadata, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	if err := decodeJSON(metadata, &record.Metadata); err != nil {
		return nil, err
	}
	record.CreatedAt = timeFromUnixNano(createdAt)
	record.UpdatedAt = timeFromUnixNano(updatedAt)
	return &record, nil
}
