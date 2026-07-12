package sqliterepo

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

type DeploymentBinding struct {
	DeploymentID    string
	ConfigHash      string
	SyntheticUserID string
	BoundAt         time.Time
}

type DeploymentIdentityRepo struct{ db *sql.DB }

func NewDeploymentIdentityRepo(db *sql.DB) *DeploymentIdentityRepo {
	return &DeploymentIdentityRepo{db: db}
}

// Bind inserts the immutable singleton on first boot, then reads it back in
// the same IMMEDIATE transaction. A conflict never mutates the existing row.
func (r *DeploymentIdentityRepo) Bind(ctx context.Context, requested DeploymentBinding) error {
	if requested.DeploymentID == "" || requested.ConfigHash == "" || requested.SyntheticUserID == "" {
		return fmt.Errorf("deployment identity: deployment id, config hash, and synthetic user id are required")
	}
	boundAt := requested.BoundAt
	if boundAt.IsZero() {
		boundAt = time.Now()
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("deployment identity: begin bind: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO deployment_identity(singleton, deployment_id, config_hash, synthetic_user_id, bound_at)
VALUES(1, ?, ?, ?, ?)
ON CONFLICT(singleton) DO NOTHING`, requested.DeploymentID, requested.ConfigHash, requested.SyntheticUserID, unixNano(boundAt)); err != nil {
		return fmt.Errorf("deployment identity: insert binding: %w", err)
	}

	var stored DeploymentBinding
	var storedBoundAt int64
	if err := tx.QueryRowContext(ctx, `
SELECT deployment_id, config_hash, synthetic_user_id, bound_at
FROM deployment_identity WHERE singleton = 1`).Scan(
		&stored.DeploymentID, &stored.ConfigHash, &stored.SyntheticUserID, &storedBoundAt,
	); err != nil {
		return fmt.Errorf("deployment identity: read binding: %w", err)
	}
	if stored.DeploymentID != requested.DeploymentID || stored.ConfigHash != requested.ConfigHash || stored.SyntheticUserID != requested.SyntheticUserID {
		return fmt.Errorf(
			"deployment identity mismatch: database is bound to deployment %q hash %s, loaded deployment %q hash %s",
			stored.DeploymentID, stored.ConfigHash, requested.DeploymentID, requested.ConfigHash,
		)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("deployment identity: commit bind: %w", err)
	}
	return nil
}
