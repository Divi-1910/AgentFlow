package repository

import (
	"context"
	"fmt"
	"time"

	"backend/memory"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MemoryRevisionRepo struct {
	col *mongo.Collection
}

func NewMemoryRevisionRepo(col *mongo.Collection) *MemoryRevisionRepo {
	return &MemoryRevisionRepo{col: col}
}

type memoryRevisionBSON struct {
	LineageKey   string     `bson:"lineage_key"`
	Revision     int        `bson:"revision"`
	MutationID   string     `bson:"mutation_id"`
	RunID        string     `bson:"run_id"`
	ToolCallID   string     `bson:"tool_call_id"`
	Operation    string     `bson:"operation"`
	Reason       string     `bson:"reason,omitempty"`
	RestoredFrom *int       `bson:"restored_from,omitempty"`
	UserID       string     `bson:"user_id"`
	AgentID      string     `bson:"agent_id"`
	ThreadID     string     `bson:"thread_id"`
	MemoryID     string     `bson:"memory_id"`
	Scope        string     `bson:"scope"`
	Type         string     `bson:"type"`
	Importance   float64    `bson:"importance"`
	BodyPath     string     `bson:"body_path"`
	CreatedAt    time.Time  `bson:"created_at"`
	UpdatedAt    time.Time  `bson:"updated_at"`
	ExpiresAt    *time.Time `bson:"expires_at,omitempty"`
	RetiredAt    *time.Time `bson:"retired_at,omitempty"`
}

func (r *MemoryRevisionRepo) EnsureIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys: bson.D{
				{Key: "lineage_key", Value: 1},
				{Key: "revision", Value: 1},
			},
			Options: options.Index().SetUnique(true).SetName("memory_revisions_lineage_revision"),
		},
		{
			Keys:    bson.D{{Key: "mutation_id", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("memory_revisions_mutation"),
		},
		{
			Keys: bson.D{
				{Key: "lineage_key", Value: 1},
				{Key: "revision", Value: -1},
			},
			Options: options.Index().SetName("memory_revisions_latest"),
		},
	}
	if _, err := r.col.Indexes().CreateMany(ctx, indexes); err != nil {
		return fmt.Errorf("memory_revision_repo: indexes: %w", err)
	}
	return nil
}

// Append writes a new revision. It is idempotent by mutation_id: replaying the
// same mutation on the same lineage returns the existing revision with the bool
// set true (no duplicate row). Reusing a mutation_id on a DIFFERENT lineage is
// rejected with ErrRevisionConflict. A fresh insert returns the bool false.
func (r *MemoryRevisionRepo) Append(ctx context.Context, rev memory.MemoryRevision) (*memory.MemoryRevision, bool, error) {
	raw := fromMemoryRevision(rev)
	if _, err := r.col.InsertOne(ctx, raw); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			existing, findErr := r.FindByMutation(ctx, rev.MutationID)
			if findErr != nil {
				return nil, false, findErr
			}
			if existing != nil && existing.LineageKey == rev.LineageKey {
				return existing, true, nil
			}
			return nil, false, memory.ErrRevisionConflict
		}
		return nil, false, fmt.Errorf("memory_revision_repo: append: %w", err)
	}
	cp := rev
	return &cp, false, nil
}

func (r *MemoryRevisionRepo) FindByMutation(ctx context.Context, mutationID string) (*memory.MemoryRevision, error) {
	var raw memoryRevisionBSON
	err := r.col.FindOne(ctx, bson.D{{Key: "mutation_id", Value: mutationID}}).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("memory_revision_repo: find mutation: %w", err)
	}
	rev := toMemoryRevision(raw)
	return &rev, nil
}

func (r *MemoryRevisionRepo) Latest(ctx context.Context, lineageKey string) (*memory.MemoryRevision, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "revision", Value: -1}})
	var raw memoryRevisionBSON
	err := r.col.FindOne(ctx, bson.D{{Key: "lineage_key", Value: lineageKey}}, opts).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("memory_revision_repo: latest: %w", err)
	}
	rev := toMemoryRevision(raw)
	return &rev, nil
}

func (r *MemoryRevisionRepo) FindRevision(ctx context.Context, lineageKey string, revision int) (*memory.MemoryRevision, error) {
	filter := bson.D{
		{Key: "lineage_key", Value: lineageKey},
		{Key: "revision", Value: revision},
	}
	var raw memoryRevisionBSON
	err := r.col.FindOne(ctx, filter).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("memory_revision_repo: find revision: %w", err)
	}
	rev := toMemoryRevision(raw)
	return &rev, nil
}

func (r *MemoryRevisionRepo) List(ctx context.Context, lineageKey string) ([]memory.MemoryRevision, error) {
	opts := options.Find().SetSort(bson.D{{Key: "revision", Value: 1}})
	cursor, err := r.col.Find(ctx, bson.D{{Key: "lineage_key", Value: lineageKey}}, opts)
	if err != nil {
		return nil, fmt.Errorf("memory_revision_repo: list: %w", err)
	}
	defer cursor.Close(ctx)

	var raws []memoryRevisionBSON
	if err := cursor.All(ctx, &raws); err != nil {
		return nil, fmt.Errorf("memory_revision_repo: decode list: %w", err)
	}
	revs := make([]memory.MemoryRevision, len(raws))
	for i, raw := range raws {
		revs[i] = toMemoryRevision(raw)
	}
	return revs, nil
}

func fromMemoryRevision(rev memory.MemoryRevision) memoryRevisionBSON {
	return memoryRevisionBSON{
		LineageKey:   rev.LineageKey,
		Revision:     rev.Revision,
		MutationID:   rev.MutationID,
		RunID:        rev.RunID,
		ToolCallID:   rev.ToolCallID,
		Operation:    rev.Operation,
		Reason:       rev.Reason,
		RestoredFrom: rev.RestoredFrom,
		UserID:       rev.UserID,
		AgentID:      rev.AgentID,
		ThreadID:     rev.ThreadID,
		MemoryID:     rev.MemoryID,
		Scope:        rev.Scope,
		Type:         rev.Type,
		Importance:   rev.Importance,
		BodyPath:     rev.BodyPath,
		CreatedAt:    rev.CreatedAt,
		UpdatedAt:    rev.UpdatedAt,
		ExpiresAt:    rev.ExpiresAt,
		RetiredAt:    rev.RetiredAt,
	}
}

func toMemoryRevision(raw memoryRevisionBSON) memory.MemoryRevision {
	return memory.MemoryRevision{
		LineageKey:   raw.LineageKey,
		Revision:     raw.Revision,
		MutationID:   raw.MutationID,
		RunID:        raw.RunID,
		ToolCallID:   raw.ToolCallID,
		Operation:    raw.Operation,
		Reason:       raw.Reason,
		RestoredFrom: raw.RestoredFrom,
		UserID:       raw.UserID,
		AgentID:      raw.AgentID,
		ThreadID:     raw.ThreadID,
		MemoryID:     raw.MemoryID,
		Scope:        raw.Scope,
		Type:         raw.Type,
		Importance:   raw.Importance,
		BodyPath:     raw.BodyPath,
		CreatedAt:    raw.CreatedAt,
		UpdatedAt:    raw.UpdatedAt,
		ExpiresAt:    raw.ExpiresAt,
		RetiredAt:    raw.RetiredAt,
	}
}
