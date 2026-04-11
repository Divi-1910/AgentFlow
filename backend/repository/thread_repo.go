package repository

import (
	"context"
	"fmt"
	"time"

	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type ThreadRepo struct {
	col *mongo.Collection
}

func NewThreadRepo(col *mongo.Collection) *ThreadRepo {
	return &ThreadRepo{col: col}
}

func (r *ThreadRepo) Create(ctx context.Context, userID, agentID, title string) (*model.ThreadDocument, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}

	if title == "" {
		title = "New Thread"
	}

	now := time.Now()
	doc := model.ThreadDocument{
		ID:        bson.NewObjectID(),
		UserID:    uid,
		AgentID:   aid,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if _, err := r.col.InsertOne(ctx, doc); err != nil {
		return nil, fmt.Errorf("thread_repo: insert failed: %w", err)
	}

	return &doc, nil
}

func (r *ThreadRepo) GetByID(ctx context.Context, threadID, userID string) (*model.ThreadDocument, error) {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return nil, fmt.Errorf("invalid thread_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	var doc model.ThreadDocument
	err = r.col.FindOne(ctx, bson.M{"_id": tid, "user_id": uid}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, fmt.Errorf("thread not found")
	}
	if err != nil {
		return nil, fmt.Errorf("thread_repo: find failed: %w", err)
	}

	return &doc, nil
}

func (r *ThreadRepo) ListByAgent(ctx context.Context, agentID, userID string) ([]*model.ThreadDocument, error) {
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	opts := options.Find().SetSort(bson.D{{Key: "created_at", Value: -1}})
	cursor, err := r.col.Find(ctx, bson.M{"agent_id": aid, "user_id": uid}, opts)
	if err != nil {
		return nil, fmt.Errorf("thread_repo: find failed: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []*model.ThreadDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("thread_repo: decode failed: %w", err)
	}

	return docs, nil
}

func (r *ThreadRepo) UpdateSummary(ctx context.Context, threadID, userID, summary string) error {
	tid, err := bson.ObjectIDFromHex(threadID)
	if err != nil {
		return fmt.Errorf("invalid thread_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return fmt.Errorf("invalid user_id: %w", err)
	}

	_, err = r.col.UpdateOne(
		ctx,
		bson.M{"_id": tid, "user_id": uid},
		bson.M{"$set": bson.M{
			"summary":    summary,
			"updated_at": time.Now(),
		}},
	)
	if err != nil {
		return fmt.Errorf("thread_repo: update summary failed: %w", err)
	}

	return nil
}
