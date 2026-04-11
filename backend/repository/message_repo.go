package repository

import (
	"context"
	"fmt"
	"time"

	"backend/llm"
	"backend/model"

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

func (r *MessageRepo) InsertMany(
	ctx context.Context,
	threadID, agentID, userID string,
	messages []llm.ChatMessage,
) error {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return fmt.Errorf("invalid thread_id: %w", err)
	}
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return fmt.Errorf("invalid user_id: %w", err)
	}

	now := time.Now()
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

		if m.Metadata != nil {
			doc.Metadata = m.Metadata
			// Promote tool_name to its own field for easier querying and indexing
			if name, ok := m.Metadata["tool_name"].(string); ok {
				doc.ToolName = name
			}
		}

		docs = append(docs, doc)
	}

	opts := options.InsertMany().SetOrdered(true)
	if _, err := r.col.InsertMany(ctx, docs, opts); err != nil {
		return fmt.Errorf("message_repo: insert failed: %w", err)
	}

	return nil
}

func (r *MessageRepo) ListRecentByThread(ctx context.Context, threadID string, limit int) ([]llm.ChatMessage, error) {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return nil, fmt.Errorf("invalid thread_id: %w", err)
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}}).
		SetLimit(int64(limit))

	cursor, err := r.col.Find(ctx, bson.M{"thread_id": tid}, opts)
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

	messages := make([]llm.ChatMessage, len(docs))
	for i, d := range docs {
		messages[i] = llm.ChatMessage{
			Role:       d.Role,
			Content:    d.Content,
			ToolCallID: d.ToolCallID,
		}
	}

	return messages, nil
}
