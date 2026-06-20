package mongorepo

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
// File content (body) is stored separately on disk and is never deleted —
// it is preserved on disk for audit/review purposes even after soft-deletion.
type MemoryMetaRepo struct {
	col *mongo.Collection
}

func NewMemoryMetaRepo(col *mongo.Collection) *MemoryMetaRepo {
	return &MemoryMetaRepo{col: col}
}

// memoryMetaBSON is the wire format for a memory_meta document.
// deleted_at is set by the cleanup worker when a record expires; it is never
// unset except by a new Upsert (agent re-writing the same memory slot).
type memoryMetaBSON struct {
	LineageKey string     `bson:"lineage_key"`
	UserID     string     `bson:"user_id"`
	AgentID    string     `bson:"agent_id"`
	ThreadID   string     `bson:"thread_id"`
	MemoryID   string     `bson:"memory_id"`
	Scope      string     `bson:"scope"`
	Type       string     `bson:"type"`
	Importance float64    `bson:"importance"`
	Revision   int        `bson:"revision"`
	BodyPath   string     `bson:"body_path"`
	CreatedAt  time.Time  `bson:"created_at"`
	UpdatedAt  time.Time  `bson:"updated_at"`
	ExpiresAt  *time.Time `bson:"expires_at"`
	RetiredAt  *time.Time `bson:"retired_at"`
	LastReadAt *time.Time `bson:"last_read_at"`
	DeletedAt  *time.Time `bson:"deleted_at"`
	Summary    string     `bson:"summary,omitempty"`
}

func (r *MemoryMetaRepo) EnsureIndexes(ctx context.Context) error {
	_ = r.col.Indexes().DropOne(ctx, "agent_id_1_scope_1_memory_id_1")
	_ = r.col.Indexes().DropOne(ctx, "user_scope_unique")

	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "lineage_key", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("lineage_unique"),
		},
		{
			Keys: bson.D{
				{Key: "user_id", Value: 1},
				{Key: "scope", Value: 1},
				{Key: "memory_id", Value: 1},
			},
			Options: options.Index().
				SetUnique(true).
				SetName("memory_meta_user_unique").
				SetPartialFilterExpression(bson.D{{Key: "scope", Value: memory.ScopeUser}}),
		},
		{
			Keys: bson.D{
				{Key: "user_id", Value: 1},
				{Key: "agent_id", Value: 1},
				{Key: "scope", Value: 1},
				{Key: "memory_id", Value: 1},
			},
			Options: options.Index().
				SetUnique(true).
				SetName("memory_meta_agent_unique").
				SetPartialFilterExpression(bson.D{{Key: "scope", Value: memory.ScopeAgent}}),
		},
		{
			Keys: bson.D{
				{Key: "user_id", Value: 1},
				{Key: "agent_id", Value: 1},
				{Key: "thread_id", Value: 1},
				{Key: "scope", Value: 1},
				{Key: "memory_id", Value: 1},
			},
			Options: options.Index().
				SetUnique(true).
				SetName("memory_meta_thread_unique").
				SetPartialFilterExpression(bson.D{{Key: "scope", Value: memory.ScopeThread}}),
		},
		{
			Keys: bson.D{
				{Key: "user_id", Value: 1},
				{Key: "agent_id", Value: 1},
				{Key: "thread_id", Value: 1},
				{Key: "scope", Value: 1},
				{Key: "expires_at", Value: 1},
				{Key: "retired_at", Value: 1},
			},
			Options: options.Index().SetName("memory_meta_visibility"),
		},
	}
	if _, err := r.col.Indexes().CreateMany(ctx, indexes); err != nil {
		return fmt.Errorf("memory_meta_repo: indexes: %w", err)
	}
	return nil
}

// Upsert projects the latest revision into memory_meta. Projection is
// monotonic: a stale revision never overwrites a newer cache row, while the
// same revision can repair summary/body_path/index fields. last_read_at is
// preserved because it is managed exclusively by StampRead.
func (r *MemoryMetaRepo) Upsert(ctx context.Context, doc memory.MemoryDocument) error {
	raw, err := fromMemoryDocument(doc)
	if err != nil {
		return err
	}
	filter := bson.D{
		{Key: "lineage_key", Value: raw.LineageKey},
		{Key: "$or", Value: bson.A{
			bson.D{{Key: "revision", Value: bson.D{{Key: "$lte", Value: raw.Revision}}}},
			bson.D{{Key: "revision", Value: bson.D{{Key: "$exists", Value: false}}}},
		}},
	}
	update := bson.D{
		{Key: "$set", Value: projectionSet(raw)},
		{Key: "$unset", Value: bson.D{{Key: "body_sha", Value: ""}}},
	}
	_, err = r.col.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			// A row either raced in, or an existing newer revision did not match
			// the revision <= incoming filter. Retry without upsert: this repairs
			// same/older raced rows and no-ops for newer rows.
			if _, retryErr := r.col.UpdateOne(ctx, filter, update); retryErr != nil {
				return fmt.Errorf("memory_meta_repo: retry projection: %w", retryErr)
			}
			return nil
		}
		return fmt.Errorf("memory_meta_repo: upsert projection: %w", err)
	}
	return nil
}

// FindActive returns all non-expired, non-soft-deleted metadata records
// visible within searchScope, applying scope-expansion rules:
//
//	thread → thread records for this agent+thread
//	agent  → agent records for this agent + thread records above
//	user   → user records for this user + agent + thread records above
func (r *MemoryMetaRepo) FindActive(ctx context.Context, execScope runtimectx.MemoryScope, searchScope string, typeFilter *string, includeRetired bool, now time.Time) ([]memory.MemoryDocument, error) {
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
		bson.D{{Key: "deleted_at", Value: nil}}, // exclude soft-deleted records
	}
	if !includeRetired {
		andClauses = append(andClauses, bson.D{{Key: "retired_at", Value: nil}})
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
func (r *MemoryMetaRepo) StampRead(ctx context.Context, doc memory.MemoryDocument) error {
	filter := bson.D{{Key: "lineage_key", Value: doc.LineageKey}}
	if doc.LineageKey == "" {
		filter = bson.D{
			{Key: "agent_id", Value: doc.AgentID},
			{Key: "scope", Value: doc.Scope},
			{Key: "memory_id", Value: doc.ID},
		}
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

// FindExpired returns all non-soft-deleted metadata records where expires_at
// is set and is on or before now. Results are capped at MaxScannedFiles —
// remaining records are handled on the next weekly tick.
func (r *MemoryMetaRepo) FindExpired(ctx context.Context, now time.Time) ([]memory.MemoryDocument, error) {
	filter := bson.D{{Key: "$and", Value: bson.A{
		bson.D{{Key: "expires_at", Value: bson.D{
			{Key: "$ne", Value: nil},
			{Key: "$lte", Value: now},
		}}},
		bson.D{{Key: "deleted_at", Value: nil}}, // don't re-process already soft-deleted
	}}}
	opts := options.Find().SetLimit(int64(memory.MaxScannedFiles))

	cursor, err := r.col.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("memory_meta_repo: find expired: %w", err)
	}
	defer cursor.Close(ctx)

	var raws []memoryMetaBSON
	if err := cursor.All(ctx, &raws); err != nil {
		return nil, fmt.Errorf("memory_meta_repo: decode expired: %w", err)
	}

	docs := make([]memory.MemoryDocument, len(raws))
	for i, raw := range raws {
		docs[i] = toMemoryDocument(raw)
	}
	return docs, nil
}

// SoftDelete marks (agentID, scope, memoryID) as deleted by setting deleted_at
// to now. The corresponding file on disk is preserved for audit/review.
// Soft-deleted records are excluded from FindOne and FindActive results.
func (r *MemoryMetaRepo) SoftDelete(ctx context.Context, agentID, scope, memoryID string) error {
	filter := bson.D{
		{Key: "agent_id", Value: agentID},
		{Key: "scope", Value: scope},
		{Key: "memory_id", Value: memoryID},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "deleted_at", Value: time.Now().UTC()},
	}}}
	_, err := r.col.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("memory_meta_repo: soft delete: %w", err)
	}
	return nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// buildScopeConditions translates a searchScope string into the $or clauses
// that cover all memory scopes visible at that level.
func buildScopeConditions(execScope runtimectx.MemoryScope, searchScope string) bson.A {
	threadCond := bson.D{
		{Key: "user_id", Value: execScope.UserID},
		{Key: "agent_id", Value: execScope.AgentID},
		{Key: "thread_id", Value: execScope.ThreadID},
		{Key: "scope", Value: memory.ScopeThread},
	}
	agentCond := bson.D{
		{Key: "user_id", Value: execScope.UserID},
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
		LineageKey: raw.LineageKey,
		UserID:     raw.UserID,
		AgentID:    raw.AgentID,
		ThreadID:   raw.ThreadID,
		ID:         raw.MemoryID,
		Type:       raw.Type,
		Scope:      raw.Scope,
		Importance: raw.Importance,
		Revision:   raw.Revision,
		BodyPath:   raw.BodyPath,
		CreatedAt:  raw.CreatedAt,
		UpdatedAt:  raw.UpdatedAt,
		ExpiresAt:  raw.ExpiresAt,
		RetiredAt:  raw.RetiredAt,
		LastReadAt: raw.LastReadAt,
		Summary:    raw.Summary,
	}
}

func fromMemoryDocument(doc memory.MemoryDocument) (memoryMetaBSON, error) {
	lineageKey := doc.LineageKey
	if lineageKey == "" {
		key, err := memory.LineageKey(runtimectx.MemoryScope{
			UserID:   doc.UserID,
			AgentID:  doc.AgentID,
			ThreadID: doc.ThreadID,
		}, doc.Scope, doc.ID)
		if err != nil {
			return memoryMetaBSON{}, fmt.Errorf("memory_meta_repo: lineage key: %w", err)
		}
		lineageKey = key
	}
	revision := doc.Revision
	if revision <= 0 {
		revision = 1
	}
	updatedAt := doc.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = doc.CreatedAt
	}
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	return memoryMetaBSON{
		LineageKey: lineageKey,
		UserID:     doc.UserID,
		AgentID:    doc.AgentID,
		ThreadID:   doc.ThreadID,
		MemoryID:   doc.ID,
		Scope:      doc.Scope,
		Type:       doc.Type,
		Importance: doc.Importance,
		Revision:   revision,
		BodyPath:   doc.BodyPath,
		CreatedAt:  doc.CreatedAt,
		UpdatedAt:  updatedAt,
		ExpiresAt:  doc.ExpiresAt,
		RetiredAt:  doc.RetiredAt,
		LastReadAt: doc.LastReadAt,
		Summary:    doc.Summary,
	}, nil
}

func projectionSet(raw memoryMetaBSON) bson.D {
	return bson.D{
		{Key: "lineage_key", Value: raw.LineageKey},
		{Key: "user_id", Value: raw.UserID},
		{Key: "agent_id", Value: raw.AgentID},
		{Key: "thread_id", Value: raw.ThreadID},
		{Key: "memory_id", Value: raw.MemoryID},
		{Key: "scope", Value: raw.Scope},
		{Key: "type", Value: raw.Type},
		{Key: "importance", Value: raw.Importance},
		{Key: "revision", Value: raw.Revision},
		{Key: "body_path", Value: raw.BodyPath},
		{Key: "created_at", Value: raw.CreatedAt},
		{Key: "updated_at", Value: raw.UpdatedAt},
		{Key: "expires_at", Value: raw.ExpiresAt},
		{Key: "retired_at", Value: raw.RetiredAt},
		{Key: "deleted_at", Value: raw.DeletedAt},
		{Key: "summary", Value: raw.Summary},
	}
}
