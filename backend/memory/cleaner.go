package memory

import (
	"context"
	"log/slog"
	"time"
)

// StartCleanupWorker launches a background goroutine that soft-deletes expired
// memory metadata records on the given interval. The corresponding files on
// disk are intentionally preserved — they remain available for human audit
// and review even after the agent can no longer access them.
//
// Soft-deleted records are excluded from all agent-facing queries (FindOne,
// FindActive). If an agent later re-writes the same memory slot, the new
// Upsert clears the deleted_at marker and revives the record.
//
// Typical usage: call once at startup with a 7-day interval.
func (s *Service) StartCleanupWorker(ctx context.Context, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runCleanup(ctx)
			}
		}
	}()
}

// runCleanup performs one sweep: finds all expired, non-soft-deleted metadata
// records and marks each one as soft-deleted. Files on disk are not touched.
func (s *Service) runCleanup(ctx context.Context) {
	docs, err := s.meta.FindExpired(ctx, time.Now().UTC())
	if err != nil {
		slog.Error("memory cleanup: find expired records", "error", err)
		return
	}
	if len(docs) == 0 {
		return
	}
	slog.Info("memory cleanup: starting sweep", "expired_count", len(docs))

	marked := 0
	for _, doc := range docs {
		if err := s.meta.SoftDelete(ctx, doc.AgentID, doc.Scope, doc.ID); err != nil {
			slog.Warn("memory cleanup: soft delete failed",
				"memory_id", doc.ID, "agent_id", doc.AgentID, "error", err)
			continue
		}
		marked++
	}

	slog.Info("memory cleanup: sweep complete",
		"marked_deleted", marked, "total_expired", len(docs))
}
