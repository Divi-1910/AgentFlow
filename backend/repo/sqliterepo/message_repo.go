package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/pagination"

	"github.com/google/uuid"
)

type MessageRepo struct{ db *sql.DB }

func NewMessageRepo(db *sql.DB) *MessageRepo { return &MessageRepo{db: db} }

func (r *MessageRepo) InsertUserPrompt(ctx context.Context, threadID, agentID, userID, runID, content string) (agent.MessageRecord, bool, error) {
	record := agent.MessageRecord{
		ID: uuid.NewString(), ThreadID: threadID, AgentID: agentID, UserID: userID,
		Role: "user", Content: content, Metadata: map[string]any{"run_id": runID, "attempt": 1},
		CreatedAt: time.Now().UTC(),
	}
	metadata, err := encodeJSON(record.Metadata)
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("message_repo: prompt metadata: %w", err)
	}
	dedupeKey := "run:" + runID + ":prompt"
	res, err := r.db.ExecContext(ctx, `
INSERT OR IGNORE INTO messages(id, thread_id, agent_id, user_id, role, content, tool_call_id,
                               tool_calls_json, tool_name, metadata_json, created_at, dedupe_key)
VALUES(?, ?, ?, ?, ?, ?, '', NULL, '', ?, ?, ?)`, record.ID, threadID, agentID, userID,
		record.Role, record.Content, metadata, unixNano(record.CreatedAt), dedupeKey)
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("message_repo: insert prompt: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("message_repo: insert prompt result: %w", err)
	}
	if n > 0 {
		return record, true, nil
	}
	row := r.db.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE dedupe_key = ?`, dedupeKey)
	existing, err := scanMessage(row)
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("message_repo: load existing prompt: %w", err)
	}
	return existing, false, nil
}

// InsertMany commits the entire ordered batch or none of it. Per-message
// timestamps preserve caller order even when the clock resolution is coarse.
func (r *MessageRepo) InsertMany(ctx context.Context, threadID, agentID, userID string, messages []llm.ChatMessage) ([]agent.MessageRecord, error) {
	if len(messages) == 0 {
		return []agent.MessageRecord{}, nil
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("message_repo: begin insert: %w", err)
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	records := make([]agent.MessageRecord, 0, len(messages))
	for i, message := range messages {
		toolCalls, err := encodeJSON(message.ToolCalls)
		if err != nil {
			return nil, fmt.Errorf("message_repo: tool calls: %w", err)
		}
		metadata, err := encodeJSON(message.Metadata)
		if err != nil {
			return nil, fmt.Errorf("message_repo: metadata: %w", err)
		}
		toolName := ""
		if name, ok := message.Metadata["tool_name"].(string); ok {
			toolName = name
		}
		record := agent.MessageRecord{
			ID: uuid.NewString(), ThreadID: threadID, AgentID: agentID, UserID: userID,
			Role: message.Role, Content: message.Content, ToolCallID: message.ToolCallID,
			ToolCalls: message.ToolCalls, ToolName: toolName, Metadata: message.Metadata,
			CreatedAt: now.Add(time.Duration(i) * time.Microsecond),
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO messages(id, thread_id, agent_id, user_id, role, content, tool_call_id,
                     tool_calls_json, tool_name, metadata_json, created_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.ID, threadID, agentID, userID,
			record.Role, record.Content, record.ToolCallID, toolCalls, toolName, metadata,
			unixNano(record.CreatedAt)); err != nil {
			return nil, fmt.Errorf("message_repo: insert failed: %w", err)
		}
		records = append(records, record)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("message_repo: commit insert: %w", err)
	}
	return records, nil
}

func (r *MessageRepo) ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error) {
	if limit <= 0 {
		limit = math.MaxInt
	}
	rows, err := r.db.QueryContext(ctx, `
SELECT `+messageColumns+` FROM (
    SELECT `+messageColumns+` FROM messages
    WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
) newest
ORDER BY created_at ASC, id ASC`, threadID, limit)
	if err != nil {
		return nil, fmt.Errorf("message_repo: find failed: %w", err)
	}
	defer rows.Close()
	var records []agent.MessageRecord
	for rows.Next() {
		record, err := scanMessage(rows)
		if err != nil {
			return nil, fmt.Errorf("message_repo: decode failed: %w", err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("message_repo: iterate failed: %w", err)
	}
	return records, nil
}

func (r *MessageRepo) ListDocsByThreadPage(ctx context.Context, threadID string, request pagination.Request) (pagination.Page[agent.MessageRecord], error) {
	if request.Limit <= 0 {
		request.Limit = 50
	}
	where := `thread_id = ?`
	args := []any{threadID}
	if request.Cursor != nil {
		where += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		at := unixNano(request.Cursor.Time)
		args = append(args, at, at, request.Cursor.ID)
	}
	args = append(args, request.Limit+1)
	rows, err := r.db.QueryContext(ctx, `
SELECT `+messageColumns+` FROM messages
WHERE `+where+`
ORDER BY created_at DESC, id DESC LIMIT ?`, args...)
	if err != nil {
		return pagination.Page[agent.MessageRecord]{}, fmt.Errorf("message_repo: page find failed: %w", err)
	}
	defer rows.Close()
	var newest []agent.MessageRecord
	for rows.Next() {
		record, err := scanMessage(rows)
		if err != nil {
			return pagination.Page[agent.MessageRecord]{}, fmt.Errorf("message_repo: page decode failed: %w", err)
		}
		newest = append(newest, record)
	}
	if err := rows.Err(); err != nil {
		return pagination.Page[agent.MessageRecord]{}, fmt.Errorf("message_repo: page iterate failed: %w", err)
	}
	hasMore := len(newest) > request.Limit
	if hasMore {
		newest = newest[:request.Limit]
	}
	var next *pagination.Cursor
	if hasMore && len(newest) > 0 {
		oldest := newest[len(newest)-1]
		next = &pagination.Cursor{Kind: "messages", Time: oldest.CreatedAt, ID: oldest.ID}
	}
	for i, j := 0, len(newest)-1; i < j; i, j = i+1, j-1 {
		newest[i], newest[j] = newest[j], newest[i]
	}
	return pagination.Page[agent.MessageRecord]{Items: newest, Next: next, HasMore: hasMore}, nil
}

func (r *MessageRepo) ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error) {
	docs, err := r.ListDocsByThread(ctx, threadID, limit)
	if err != nil {
		return nil, err
	}
	messages := make([]llm.ChatMessage, len(docs))
	for i, doc := range docs {
		messages[i] = llm.ChatMessage{
			Role: doc.Role, Content: doc.Content, ToolCallID: doc.ToolCallID,
			ToolCalls: doc.ToolCalls, Metadata: doc.Metadata,
		}
	}
	return messages, nil
}

const messageColumns = `id, thread_id, agent_id, user_id, role, content,
tool_call_id, tool_calls_json, tool_name, metadata_json, created_at`

func scanMessage(s rowScanner) (agent.MessageRecord, error) {
	var (
		record                  agent.MessageRecord
		toolCallsJSON, metadata sql.NullString
		createdAt               int64
	)
	err := s.Scan(&record.ID, &record.ThreadID, &record.AgentID, &record.UserID,
		&record.Role, &record.Content, &record.ToolCallID, &toolCallsJSON,
		&record.ToolName, &metadata, &createdAt)
	if err != nil {
		return agent.MessageRecord{}, err
	}
	if err := decodeJSON(toolCallsJSON, &record.ToolCalls); err != nil {
		return agent.MessageRecord{}, fmt.Errorf("tool calls: %w", err)
	}
	if err := decodeJSON(metadata, &record.Metadata); err != nil {
		return agent.MessageRecord{}, fmt.Errorf("metadata: %w", err)
	}
	record.CreatedAt = timeFromUnixNano(createdAt)
	return record, nil
}
