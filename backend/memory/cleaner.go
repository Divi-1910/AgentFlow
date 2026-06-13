package memory

import (
	"context"
	"log/slog"
	"time"
)

// StartCleanupWorker preserves the old startup hook. Versioned memories do not
// need expiry cleanup: read/search enforce expiry against the latest revision
// and immutable blobs/revisions are intentionally retained.
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

func (s *Service) runCleanup(ctx context.Context) {
	_ = ctx
	slog.Debug("memory cleanup: versioned memories require no cleanup sweep")
}
