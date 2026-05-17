package repository

import (
	"context"
	"fmt"
	"time"

	"backend/memory"
	"backend/runtimectx"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MemoryMetaRepo implements memory.MetaStore using MongoDB.
// Each document in the collection holds all metadata for one memory record.
// File content (body) is stored separately on disk.
type MemoryMetaRepo struct {
	col *mongo.Collection
}

func NewMemoryMetaRepo(col *mongo.Collection) *MemoryMetaRepo {
	return &MemoryMetaRepo{col: col}
}

// memoryMetaBSON is the wire format for a memory_meta document.
type memoryMetaBSON struct {
	UserID     string     `bson:"user_id"`
	AgentID    string     `bson:"agent_id"`
	ThreadID   string     `bson:"thread_id"`
	MemoryID   string     `bson:"memory_id"`
	Scope      string     `bson:"scope"`
	Type       string     `bson:"type"`
	Importance float64    `bson:"importance"`
	CreatedAt  time.Time  `bson:"created_at"`
	ExpiresAt  *time.Time `bson:"expires_at"`
	LastReadAt *time.Time `bson:"last_read_at"`
}

func (r *MemoryMetaRepo) EnsureIndexes(ctx context.Context) error {
	// Primary lookup: unique per (agent_id, scope, memory_id).
	_, err := r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "agent_id", Value: 1},
			{Key: "scope", Value: 1},
			{Key: "memory_id", Value: 1},
		},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("memory_meta_repo: primary index: %w", err)
	}

	// Query index to accelerate FindActive (scope + expiry filter).
	_, err = r.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "agent_id", Value: 1},
			{Key: "scope", Value: 1},
			{Key: "expires_at", Value: 1},
		},
	})
	if err != nil {
		return fmt.Errorf("memory_meta_repo: query index: %w", err)
	}
	return nil
}

// Upsert creates or updates the metadata for a memory document.
// last_read_at is intentionally excluded from the $set to preserve the
// existing stamp value — it is managed exclusively by StampRead.
func (r *MemoryMetaRepo) Upsert(ctx context.Context, doc memory.MemoryDocument) error {
	filter := bson.D{
		{Key: "agent_id", Value: doc.AgentID},
		{Key: "scope", Value: doc.Scope},
		{Key: "memory_id", Value: doc.ID},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "user_id", Value: doc.UserID},
		{Key: "agent_id", Value: doc.AgentID},
		{Key: "thread_id", Value: doc.ThreadID},
		{Key: "memory_id", Value: doc.ID},
		{Key: "scope", Value: doc.Scope},
		{Key: "type", Value: doc.Type},
		{Key: "importance", Value: doc.Importance},
		{Key: "created_at", Value: doc.CreatedAt},
		{Key: "expires_at", Value: doc.ExpiresAt},
	}}}
	_, err := r.col.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	if err != nil {
		return fmt.Errorf("memory_meta_repo: upsert: %w", err)
	}
	return nil
}

// FindOne returns the metadata record for (agentID, scope, memoryID),
// or (nil, nil) when no record exists.
func (r *MemoryMetaRepo) FindOne(ctx context.Context, agentID, scope, memoryID string) (*memory.MemoryDocument, error) {
	filter := bson.D{
		{Key: "agent_id", Value: agentID},
		{Key: "scope", Value: scope},
		{Key: "memory_id", Value: memoryID},
	}
	var raw memoryMetaBSON
	err := r.col.FindOne(ctx, filter).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("memory_meta_repo: find one: %w", err)
	}
	doc := toMemoryDocument(raw)
	return &doc, nil
}

// FindActive returns all non-expired metadata records visible within
// searchScope, applying scope-expansion rules:
//
//	thread → thread records for this agent+thread
//	agent  → agent records for this agent + thread records above
//	user   → user records for this user + agent + thread records above
func (r *MemoryMetaRepo) FindActive(ctx context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, now time.Time) ([]memory.MemoryDocument, error) {
	scopeConditions := buildScopeConditions(execScope, searchScope)
	if len(scopeConditions) == 0 {
		return nil, fmt.Errorf("memory_meta_repo: unknown search scope %q", searchScope)
	}

	// Non-expired: expires_at is null/missing OR expires_at is in the future.
	expiryFilter := bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "expires_at", Value: bson.D{{Key: "$eq", Value: nil}}}},
		bson.D{{Key: "expires_at", Value: bson.D{{Key: "$gt", Value: now}}}},
	}}}

	andClauses := bson.A{
		bson.D{{Key: "$or", Value: scopeConditions}},
		expiryFilter,
	}
	if typeFilter != nil {
		andClauses = append(andClauses, bson.D{{Key: "type", Value: *typeFilter}})
	}

	filter := bson.D{{Key: "$and", Value: andClauses}}
	opts := options.Find().SetLimit(int64(memory.MaxScannedFiles))

	cursor, err := r.col.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("memory_meta_repo: find active: %w", err)
	}
	defer cursor.Close(ctx)

	var raws []memoryMetaBSON
	if err := cursor.All(ctx, &raws); err != nil {
		return nil, fmt.Errorf("memory_meta_repo: decode active: %w", err)
	}

	docs := make([]memory.MemoryDocument, len(raws))
	for i, raw := range raws {
		docs[i] = toMemoryDocument(raw)
	}
	return docs, nil
}

// StampRead sets last_read_at to now for (agentID, scope, memoryID).
// It only updates existing records — if no record is found the call is a no-op.
func (r *MemoryMetaRepo) StampRead(ctx context.Context, agentID, scope, memoryID string) error {
	filter := bson.D{
		{Key: "agent_id", Value: agentID},
		{Key: "scope", Value: scope},
		{Key: "memory_id", Value: memoryID},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "last_read_at", Value: time.Now().UTC()},
	}}}
	_, err := r.col.UpdateOne(ctx, filter, update) // upsert=false (default)
	if err != nil {
		return fmt.Errorf("memory_meta_repo: stamp read: %w", err)
	}
	return nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// buildScopeConditions translates a searchScope string into the $or clauses
// that cover all memory scopes visible at that level.
func buildScopeConditions(execScope runtimectx.MemoryScope, searchScope string) bson.A {
	threadCond := bson.D{
		{Key: "agent_id", Value: execScope.AgentID},
		{Key: "thread_id", Value: execScope.ThreadID},
		{Key: "scope", Value: memory.ScopeThread},
	}
	agentCond := bson.D{
		{Key: "agent_id", Value: execScope.AgentID},
		{Key: "scope", Value: memory.ScopeAgent},
	}
	userCond := bson.D{
		{Key: "user_id", Value: execScope.UserID},
		{Key: "scope", Value: memory.ScopeUser},
	}

	switch searchScope {
	case memory.ScopeThread:
		return bson.A{threadCond}
	case memory.ScopeAgent:
		return bson.A{agentCond, threadCond}
	case memory.ScopeUser:
		return bson.A{userCond, agentCond, threadCond}
	default:
		return bson.A{}
	}
}

func toMemoryDocument(raw memoryMetaBSON) memory.MemoryDocument {
	return memory.MemoryDocument{
		UserID:     raw.UserID,
		AgentID:    raw.AgentID,
		ThreadID:   raw.ThreadID,
		ID:         raw.MemoryID,
		Type:       raw.Type,
		Scope:      raw.Scope,
		Importance: raw.Importance,
		CreatedAt:  raw.CreatedAt,
		ExpiresAt:  raw.ExpiresAt,
		LastReadAt: raw.LastReadAt,
	}
}
