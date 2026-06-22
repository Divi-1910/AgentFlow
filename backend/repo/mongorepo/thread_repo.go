package mongorepo

import (
	"context"
	"fmt"
	"time"

	"backend/agent"
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

func (r *ThreadRepo) Create(ctx context.Context, userID, agentID, title string) (*agent.ThreadRecord, error) {
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

	return toThreadRecord(doc), nil
}

func (r *ThreadRepo) GetByID(ctx context.Context, threadID, userID string) (*agent.ThreadRecord, error) {
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

	return toThreadRecord(doc), nil
}

func (r *ThreadRepo) ListByAgent(ctx context.Context, agentID, userID string) ([]*agent.ThreadRecord, error) {
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent_id: %w", err)
	}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, fmt.Errorf("invalid user_id: %w", err)
	}

	opts := options.Find().SetSort(bson.D{{Key: "created_at", Value: -1}})
	// Exclude delegation sub-threads (kind == "sub") from user-facing lists.
	cursor, err := r.col.Find(ctx, bson.M{
		"agent_id": aid,
		"user_id":  uid,
		"kind":     bson.M{"$ne": "sub"},
	}, opts)
	if err != nil {
		return nil, fmt.Errorf("thread_repo: find failed: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []model.ThreadDocument
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("thread_repo: decode failed: %w", err)
	}

	records := make([]*agent.ThreadRecord, len(docs))
	for i, doc := range docs {
		records[i] = toThreadRecord(doc)
	}
	return records, nil
}

// FindOrCreateSubThread returns the sub-thread for (userID, originatorRunID,
// agentID), creating it atomically on first call. The partial unique index
// (see EnsureIndexes) guarantees concurrent delegate calls to the same agent
// within one originator run converge on a single sub-thread. Returns the
// thread ID hex.
func (r *ThreadRepo) FindOrCreateSubThread(ctx context.Context, userID, originatorRunID, agentID string) (string, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return "", fmt.Errorf("invalid user_id: %w", err)
	}
	aid, err := bson.ObjectIDFromHex(agentID)
	if err != nil {
		return "", fmt.Errorf("invalid agent_id: %w", err)
	}
	if originatorRunID == "" {
		return "", fmt.Errorf("thread_repo: originator_run_id is required for a sub-thread")
	}

	now := time.Now()
	filter := bson.M{
		"user_id":           uid,
		"agent_id":          aid,
		"originator_run_id": originatorRunID,
		"kind":              "sub",
	}
	update := bson.M{
		"$setOnInsert": bson.M{
			"user_id":           uid,
			"agent_id":          aid,
			"originator_run_id": originatorRunID,
			"kind":              "sub",
			"title":             "delegation",
			"created_at":        now,
			"updated_at":        now,
		},
	}
	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)

	var doc model.ThreadDocument
	if err := r.col.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc); err != nil {
		if !mongo.IsDuplicateKeyError(err) {
			return "", fmt.Errorf("thread_repo: find-or-create sub-thread: %w", err)
		}
		// Two upserts can both miss before the unique index admits one. The
		// loser reads the winner instead of leaking a transient duplicate-key
		// error through the storage-neutral port.
		if findErr := r.col.FindOne(ctx, filter).Decode(&doc); findErr != nil {
			return "", fmt.Errorf("thread_repo: recover raced sub-thread: %w", findErr)
		}
	}
	return doc.ID.Hex(), nil
}

// EnsureIndexes creates the partial unique index that enforces one sub-thread
// per (user_id, originator_run_id, agent_id). The partial filter scopes
// uniqueness to kind == "sub", so user-facing threads (empty kind) are
// unaffected.
func (r *ThreadRepo) EnsureIndexes(ctx context.Context) error {
	_, err := r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "user_id", Value: 1},
			{Key: "originator_run_id", Value: 1},
			{Key: "agent_id", Value: 1},
		},
		Options: options.Index().
			SetUnique(true).
			SetName("sub_thread_unique").
			SetPartialFilterExpression(bson.M{"kind": "sub"}),
	})
	if err != nil {
		return fmt.Errorf("thread_repo: sub-thread index: %w", err)
	}
	return nil
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

// toThreadRecord translates a stored BSON document into the storage-neutral
// domain record, rendering ObjectIDs as hex strings.
func toThreadRecord(doc model.ThreadDocument) *agent.ThreadRecord {
	return &agent.ThreadRecord{
		ID:              doc.ID.Hex(),
		UserID:          doc.UserID.Hex(),
		AgentID:         doc.AgentID.Hex(),
		Kind:            doc.Kind,
		OriginatorRunID: doc.OriginatorRunID,
		Title:           doc.Title,
		Summary:         doc.Summary,
		Metadata:        doc.Metadata,
		CreatedAt:       doc.CreatedAt,
		UpdatedAt:       doc.UpdatedAt,
	}
}
