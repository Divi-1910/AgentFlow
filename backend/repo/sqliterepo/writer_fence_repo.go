package sqliterepo

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var (
	ErrWriterGenerationStale    = errors.New("managed writer generation is stale")
	ErrWriterGenerationConflict = errors.New("managed writer generation identity conflict")

	runtimeInstanceRE = regexp.MustCompile(`^instance_[0-9a-f]{32}$`)
)

type WriterFenceClaim struct {
	Generation        int64
	Revision          int
	ConfigHash        string
	RuntimeInstanceID string
	StartedAt         time.Time
}

type WriterFenceRepo struct{ db *sql.DB }

func NewWriterFenceRepo(db *sql.DB) *WriterFenceRepo {
	return &WriterFenceRepo{db: db}
}

// Claim records the largest generation ever admitted to this deployment
// volume. Reusing that generation is allowed only for the exact same revision
// and config hash, which permits a crashed pod to restart without allowing a
// different deployment target to reuse the generation.
func (r *WriterFenceRepo) Claim(ctx context.Context, requested WriterFenceClaim) error {
	if err := validateWriterFenceClaim(requested); err != nil {
		return err
	}
	if requested.StartedAt.IsZero() {
		requested.StartedAt = time.Now().UTC()
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("managed writer fence: begin claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
INSERT INTO runtime_writer_fence(
    singleton,
    maximum_generation_seen,
    active_generation,
    active_revision,
    active_config_hash,
    runtime_instance_id,
    started_at
)
VALUES(1, ?, ?, ?, ?, ?, ?)
ON CONFLICT(singleton) DO NOTHING`,
		requested.Generation,
		requested.Generation,
		requested.Revision,
		requested.ConfigHash,
		requested.RuntimeInstanceID,
		unixNano(requested.StartedAt),
	)
	if err != nil {
		return fmt.Errorf("managed writer fence: insert claim: %w", err)
	}

	stored, err := readWriterFenceClaim(ctx, tx)
	if err != nil {
		return err
	}
	switch {
	case requested.Generation < stored.Generation:
		return fmt.Errorf(
			"%w: requested generation %d, maximum generation %d",
			ErrWriterGenerationStale,
			requested.Generation,
			stored.Generation,
		)
	case requested.Generation == stored.Generation &&
		(requested.Revision != stored.Revision || requested.ConfigHash != stored.ConfigHash):
		return fmt.Errorf(
			"%w: generation %d is bound to revision %d and config hash %s",
			ErrWriterGenerationConflict,
			stored.Generation,
			stored.Revision,
			stored.ConfigHash,
		)
	}

	_, err = tx.ExecContext(ctx, `
UPDATE runtime_writer_fence
SET maximum_generation_seen = ?,
    active_generation = ?,
    active_revision = ?,
    active_config_hash = ?,
    runtime_instance_id = ?,
    started_at = ?
WHERE singleton = 1`,
		requested.Generation,
		requested.Generation,
		requested.Revision,
		requested.ConfigHash,
		requested.RuntimeInstanceID,
		unixNano(requested.StartedAt),
	)
	if err != nil {
		return fmt.Errorf("managed writer fence: activate claim: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("managed writer fence: commit claim: %w", err)
	}
	return nil
}

// Release clears only the active process marker. The maximum generation and
// its revision/config identity remain durable so an older pod cannot become a
// writer after the newer pod exits.
func (r *WriterFenceRepo) Release(ctx context.Context, claim WriterFenceClaim) (bool, error) {
	if err := validateWriterFenceClaim(claim); err != nil {
		return false, err
	}
	result, err := r.db.ExecContext(ctx, `
UPDATE runtime_writer_fence
SET runtime_instance_id = '', started_at = 0
WHERE singleton = 1
  AND maximum_generation_seen = ?
  AND active_generation = ?
  AND active_revision = ?
  AND active_config_hash = ?
  AND runtime_instance_id = ?`,
		claim.Generation,
		claim.Generation,
		claim.Revision,
		claim.ConfigHash,
		claim.RuntimeInstanceID,
	)
	if err != nil {
		return false, fmt.Errorf("managed writer fence: release claim: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("managed writer fence: inspect release: %w", err)
	}
	return rows == 1, nil
}

func readWriterFenceClaim(ctx context.Context, tx *sql.Tx) (WriterFenceClaim, error) {
	var (
		claim            WriterFenceClaim
		activeGeneration int64
		startedAt        int64
	)
	err := tx.QueryRowContext(ctx, `
SELECT maximum_generation_seen,
       active_generation,
       active_revision,
       active_config_hash,
       runtime_instance_id,
       started_at
FROM runtime_writer_fence
WHERE singleton = 1`).Scan(
		&claim.Generation,
		&activeGeneration,
		&claim.Revision,
		&claim.ConfigHash,
		&claim.RuntimeInstanceID,
		&startedAt,
	)
	if err != nil {
		return WriterFenceClaim{}, fmt.Errorf("managed writer fence: read claim: %w", err)
	}
	if activeGeneration != claim.Generation {
		return WriterFenceClaim{}, fmt.Errorf(
			"managed writer fence: stored active generation %d differs from maximum %d",
			activeGeneration,
			claim.Generation,
		)
	}
	if claim.Generation <= 0 || claim.Revision <= 0 || !lowerHexDigestRE.MatchString(claim.ConfigHash) {
		return WriterFenceClaim{}, fmt.Errorf("managed writer fence: stored claim is invalid")
	}
	if claim.RuntimeInstanceID != "" && !runtimeInstanceRE.MatchString(claim.RuntimeInstanceID) {
		return WriterFenceClaim{}, fmt.Errorf("managed writer fence: stored runtime instance id is invalid")
	}
	if startedAt < 0 || (claim.RuntimeInstanceID != "" && startedAt == 0) {
		return WriterFenceClaim{}, fmt.Errorf("managed writer fence: stored start time is invalid")
	}
	claim.StartedAt = timeFromUnixNano(startedAt)
	return claim, nil
}

func validateWriterFenceClaim(claim WriterFenceClaim) error {
	if claim.Generation <= 0 || claim.Revision <= 0 {
		return fmt.Errorf("managed writer fence: generation and revision must be positive")
	}
	if !lowerHexDigestRE.MatchString(claim.ConfigHash) {
		return fmt.Errorf("managed writer fence: config hash must be a lowercase sha256 digest")
	}
	if !runtimeInstanceRE.MatchString(claim.RuntimeInstanceID) {
		return fmt.Errorf("managed writer fence: runtime instance id is invalid")
	}
	return nil
}
