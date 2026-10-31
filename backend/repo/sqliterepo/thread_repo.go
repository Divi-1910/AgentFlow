package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"backend/agent"
	"backend/pagination"

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
ORDER BY updated_at DESC, id DESC`, agentID, userID)
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

func (r *ThreadRepo) ListByAgentPage(ctx context.Context, agentID, userID string, request pagination.Request) (pagination.Page[*agent.ThreadRecord], error) {
	return r.listPage(ctx, `user_id = ? AND agent_id = ? AND kind <> 'sub'`, []any{userID, agentID}, request)
}

func (r *ThreadRepo) ListByUserPage(ctx context.Context, userID string, resourceIDs []string, request pagination.Request) (pagination.Page[*agent.ThreadRecord], error) {
	where := `user_id = ? AND kind <> 'sub'`
	args := []any{userID}
	if resourceIDs != nil {
		if len(resourceIDs) == 0 {
			return pagination.Page[*agent.ThreadRecord]{Items: []*agent.ThreadRecord{}}, nil
		}
		where += ` AND agent_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(resourceIDs)), ",") + `)`
		for _, id := range resourceIDs {
			args = append(args, id)
		}
	}
	return r.listPage(ctx, where, args, request)
}

func (r *ThreadRepo) listPage(ctx context.Context, where string, args []any, request pagination.Request) (pagination.Page[*agent.ThreadRecord], error) {
	if request.Limit <= 0 {
		request.Limit = 50
	}
	if request.Cursor != nil {
		where += ` AND (updated_at < ? OR (updated_at = ? AND id < ?))`
		at := unixNano(request.Cursor.Time)
		args = append(args, at, at, request.Cursor.ID)
	}
	args = append(args, request.Limit+1)
	rows, err := r.db.QueryContext(ctx, `SELECT `+threadColumns+` FROM threads WHERE `+where+`
ORDER BY updated_at DESC, id DESC LIMIT ?`, args...)
	if err != nil {
		return pagination.Page[*agent.ThreadRecord]{}, fmt.Errorf("thread_repo: page find failed: %w", err)
	}
	defer rows.Close()
	var items []*agent.ThreadRecord
	for rows.Next() {
		record, err := scanThread(rows)
		if err != nil {
			return pagination.Page[*agent.ThreadRecord]{}, fmt.Errorf("thread_repo: page decode failed: %w", err)
		}
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		return pagination.Page[*agent.ThreadRecord]{}, fmt.Errorf("thread_repo: page iterate failed: %w", err)
	}
	hasMore := len(items) > request.Limit
	if hasMore {
		items = items[:request.Limit]
	}
	page := pagination.Page[*agent.ThreadRecord]{Items: items, HasMore: hasMore}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		page.Next = &pagination.Cursor{Kind: "threads", Time: last.UpdatedAt, ID: last.ID}
	}
	return page, nil
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

func (r *ThreadRepo) UpdateTitle(ctx context.Context, threadID, userID, title string) error {
	result, err := r.db.ExecContext(ctx, `UPDATE threads SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
		title, unixNano(time.Now()), threadID, userID)
	if err != nil {
		return fmt.Errorf("thread_repo: update title failed: %w", err)
	}
	matched, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("thread_repo: update title result: %w", err)
	}
	if matched == 0 {
		return fmt.Errorf("thread not found")
	}
	return nil
}

func (r *ThreadRepo) Touch(ctx context.Context, threadID, userID string) error {
	result, err := r.db.ExecContext(ctx, `UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?`,
		unixNano(time.Now()), threadID, userID)
	if err != nil {
		return fmt.Errorf("thread_repo: touch failed: %w", err)
	}
	matched, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("thread_repo: touch result: %w", err)
	}
	if matched == 0 {
		return fmt.Errorf("thread not found")
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
