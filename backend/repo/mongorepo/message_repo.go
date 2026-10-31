package mongorepo

import (
	"context"
	"fmt"
	"time"

	"backend/agent"
	"backend/llm"
	"backend/model"
	"backend/pagination"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MessageRepo struct {
	col *mongo.Collection
}

func NewMessageRepo(col *mongo.Collection) *MessageRepo {
	return &MessageRepo{col: col}
}

func (r *MessageRepo) EnsureIndexes(ctx context.Context) error {
	_, err := r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "dedupe_key", Value: 1}},
		Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{
			"dedupe_key": bson.M{"$type": "string"},
		}),
	})
	if err != nil {
		return fmt.Errorf("message_repo: dedupe index: %w", err)
	}
	_, err = r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "thread_id", Value: 1}, {Key: "created_at", Value: -1}, {Key: "_id", Value: -1}},
		Options: options.Index().SetName("message_thread_window"),
	})
	if err != nil {
		return fmt.Errorf("message_repo: thread window index: %w", err)
	}
	return nil
}

func (r *MessageRepo) InsertUserPrompt(ctx context.Context, threadID, agentID, userID, runID, content string) (agent.MessageRecord, bool, error) {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("invalid thread_id: %w", err)
	}
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("invalid user_id: %w", err)
	}
	dedupeKey := "run:" + runID + ":prompt"
	doc := model.MessageDocument{
		ID: bson.NewObjectID(), ThreadID: tid, AgentID: aid, UserID: uid,
		Role: "user", Content: content, Metadata: map[string]any{"run_id": runID, "attempt": 1},
		DedupeKey: dedupeKey, CreatedAt: time.Now(),
	}
	if _, err := r.col.InsertOne(ctx, doc); err == nil {
		return toMessageRecord(doc), true, nil
	} else if !mongo.IsDuplicateKeyError(err) {
		return agent.MessageRecord{}, false, fmt.Errorf("message_repo: insert prompt: %w", err)
	}
	if err := r.col.FindOne(ctx, bson.M{"dedupe_key": dedupeKey}).Decode(&doc); err != nil {
		return agent.MessageRecord{}, false, fmt.Errorf("message_repo: load existing prompt: %w", err)
	}
	return toMessageRecord(doc), false, nil
}

func (r *MessageRepo) InsertMany(
	ctx context.Context,
	threadID, agentID, userID string,
	messages []llm.ChatMessage,
) ([]agent.MessageRecord, error) {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return nil, fmt.Errorf("invalid thread_id: %w", err)
	}
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	now := time.Now()
	typed := make([]model.MessageDocument, 0, len(messages))
	docs := make([]interface{}, 0, len(messages))

	for i, m := range messages {
		doc := model.MessageDocument{
			ID:        bson.NewObjectID(),
			ThreadID:  tid,
			AgentID:   aid,
			UserID:    uid,
			Role:      m.Role,
			Content:   m.Content,
			CreatedAt: now.Add(time.Duration(i) * time.Microsecond),
		}

		if m.ToolCallID != "" {
			doc.ToolCallID = m.ToolCallID
		}

		if len(m.ToolCalls) > 0 {
			doc.ToolCalls = m.ToolCalls
		}

		if m.Metadata != nil {
			doc.Metadata = m.Metadata
			if name, ok := m.Metadata["tool_name"].(string); ok {
				doc.ToolName = name
			}
		}

		typed = append(typed, doc)
		docs = append(docs, doc)
	}

	opts := options.InsertMany().SetOrdered(true)
	if _, err := r.col.InsertMany(ctx, docs, opts); err != nil {
		return nil, fmt.Errorf("message_repo: insert failed: %w", err)
	}

	records := make([]agent.MessageRecord, len(typed))
	for i, doc := range typed {
		records[i] = toMessageRecord(doc)
	}
	return records, nil
}

func (r *MessageRepo) ListDocsByThread(ctx context.Context, threadID string, limit int) ([]agent.MessageRecord, error) {
	if limit <= 0 {
		tid, err := bson.ObjectIDFromHex(threadID)
		if err != nil {
			return nil, fmt.Errorf("invalid thread_id: %w", err)
		}
		cursor, err := r.col.Find(ctx, bson.M{"thread_id": tid}, options.Find().
			SetSort(bson.D{{Key: "created_at", Value: -1}, {Key: "_id", Value: -1}}))
		if err != nil {
			return nil, fmt.Errorf("message_repo: find failed: %w", err)
		}
		defer cursor.Close(ctx)
		var docs []model.MessageDocument
		if err := cursor.All(ctx, &docs); err != nil {
			return nil, fmt.Errorf("message_repo: decode failed: %w", err)
		}
		for i, j := 0, len(docs)-1; i < j; i, j = i+1, j-1 {
			docs[i], docs[j] = docs[j], docs[i]
		}
		records := make([]agent.MessageRecord, len(docs))
		for i, doc := range docs {
			records[i] = toMessageRecord(doc)
		}
		return records, nil
	}
	page, err := r.ListDocsByThreadPage(ctx, threadID, pagination.Request{Limit: limit})
	return page.Items, err
}

func (r *MessageRepo) ListDocsByThreadPage(ctx context.Context, threadID string, request pagination.Request) (pagination.Page[agent.MessageRecord], error) {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return pagination.Page[agent.MessageRecord]{}, fmt.Errorf("invalid thread_id: %w", err)
	}
	if request.Limit <= 0 {
		request.Limit = 50
	}
	filter := bson.M{"thread_id": tid}
	if request.Cursor != nil {
		cursorID, err := bson.ObjectIDFromHex(request.Cursor.ID)
		if err != nil {
			return pagination.Page[agent.MessageRecord]{}, pagination.ErrInvalidCursor
		}
		filter["$or"] = bson.A{
			bson.M{"created_at": bson.M{"$lt": request.Cursor.Time}},
			bson.M{"created_at": request.Cursor.Time, "_id": bson.M{"$lt": cursorID}},
		}
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}, {Key: "_id", Value: -1}}).
		SetLimit(int64(request.Limit + 1))

	cursor, err := r.col.Find(ctx, filter, opts)
	if err != nil {
		return pagination.Page[agent.MessageRecord]{}, fmt.Errorf("message_repo: find failed: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []model.MessageDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return pagination.Page[agent.MessageRecord]{}, fmt.Errorf("message_repo: decode failed: %w", err)
	}
	hasMore := len(docs) > request.Limit
	if hasMore {
		docs = docs[:request.Limit]
	}
	var next *pagination.Cursor
	if hasMore && len(docs) > 0 {
		oldest := docs[len(docs)-1]
		next = &pagination.Cursor{Kind: "messages", Time: oldest.CreatedAt, ID: oldest.ID.Hex()}
	}

	for i, j := 0, len(docs)-1; i < j; i, j = i+1, j-1 {
		docs[i], docs[j] = docs[j], docs[i]
	}

	records := make([]agent.MessageRecord, len(docs))
	for i, doc := range docs {
		records[i] = toMessageRecord(doc)
	}
	return pagination.Page[agent.MessageRecord]{Items: records, Next: next, HasMore: hasMore}, nil
}

func (r *MessageRepo) ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error) {
	docs, err := r.ListDocsByThread(ctx, threadID, limit)
	if err != nil {
		return nil, err
	}

	messages := make([]llm.ChatMessage, len(docs))
	for i, d := range docs {
		messages[i] = llm.ChatMessage{
			Role:       d.Role,
			Content:    d.Content,
			ToolCallID: d.ToolCallID,
			ToolCalls:  d.ToolCalls,
			Metadata:   d.Metadata,
		}
	}

	return messages, nil
}

// toMessageRecord translates a stored BSON document into the storage-neutral
// domain record, rendering ObjectIDs as hex strings.
func toMessageRecord(doc model.MessageDocument) agent.MessageRecord {
	return agent.MessageRecord{
		ID:         doc.ID.Hex(),
		ThreadID:   doc.ThreadID.Hex(),
		AgentID:    doc.AgentID.Hex(),
		UserID:     doc.UserID.Hex(),
		Role:       doc.Role,
		Content:    doc.Content,
		ToolCallID: doc.ToolCallID,
		ToolCalls:  doc.ToolCalls,
		ToolName:   doc.ToolName,
		Metadata:   doc.Metadata,
		CreatedAt:  doc.CreatedAt,
	}
}
