package sqliterepo

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrStorageIdentityMismatch   = errors.New("managed storage identity mismatch")
	ErrExecutionIdentityMismatch = errors.New("managed execution identity mismatch")

	lowerHexDigestRE   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	runtimePrincipalRE = regexp.MustCompile(`^runtime_[0-9a-f]{32}$`)
)

type StorageBinding struct {
	StorageID          string
	DeploymentID       string
	RuntimePrincipalID string
	CreatedAt          time.Time
}

type StorageIdentityRepo struct{ db *sql.DB }

func NewStorageIdentityRepo(db *sql.DB) *StorageIdentityRepo {
	return &StorageIdentityRepo{db: db}
}

// Bind inserts a new storage binding or returns the binding already stored for
// the same storage and deployment. The candidate principal is used only when
// the singleton does not exist, so restarts never rotate repository ownership.
func (r *StorageIdentityRepo) Bind(ctx context.Context, candidate StorageBinding) (*StorageBinding, error) {
	if err := validateStorageBinding(candidate); err != nil {
		return nil, err
	}
	createdAt := candidate.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("managed storage identity: begin bind: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
INSERT INTO deployment_storage_identity(singleton, storage_id, deployment_id, runtime_principal_id, created_at)
VALUES(1, ?, ?, ?, ?)
ON CONFLICT(singleton) DO NOTHING`,
		candidate.StorageID,
		candidate.DeploymentID,
		candidate.RuntimePrincipalID,
		unixNano(createdAt),
	)
	if err != nil {
		return nil, fmt.Errorf("managed storage identity: insert binding: %w", err)
	}

	stored, err := readStorageBinding(ctx, tx)
	if err != nil {
		return nil, err
	}
	if stored.StorageID != candidate.StorageID || stored.DeploymentID != candidate.DeploymentID {
		return nil, fmt.Errorf(
			"%w: stored storage %q deployment %q, requested storage %q deployment %q",
			ErrStorageIdentityMismatch,
			stored.StorageID,
			stored.DeploymentID,
			candidate.StorageID,
			candidate.DeploymentID,
		)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("managed storage identity: commit bind: %w", err)
	}
	return stored, nil
}

func readStorageBinding(ctx context.Context, tx *sql.Tx) (*StorageBinding, error) {
	var (
		stored    StorageBinding
		createdAt int64
	)
	err := tx.QueryRowContext(ctx, `
SELECT storage_id, deployment_id, runtime_principal_id, created_at
FROM deployment_storage_identity WHERE singleton = 1`).Scan(
		&stored.StorageID,
		&stored.DeploymentID,
		&stored.RuntimePrincipalID,
		&createdAt,
	)
	if err != nil {
		return nil, fmt.Errorf("managed storage identity: read binding: %w", err)
	}
	stored.CreatedAt = timeFromUnixNano(createdAt)
	if err := validateStorageBinding(stored); err != nil {
		return nil, fmt.Errorf("managed storage identity: stored binding invalid: %w", err)
	}
	return &stored, nil
}

func validateStorageBinding(binding StorageBinding) error {
	if !lowerHexDigestRE.MatchString(binding.StorageID) {
		return fmt.Errorf("managed storage identity: storage id must be a lowercase sha256 digest")
	}
	if strings.TrimSpace(binding.DeploymentID) == "" {
		return fmt.Errorf("managed storage identity: deployment id is required")
	}
	if !runtimePrincipalRE.MatchString(binding.RuntimePrincipalID) {
		return fmt.Errorf("managed storage identity: runtime principal id is invalid")
	}
	return nil
}

type ExecutionBinding struct {
	StorageID           string
	DeploymentID        string
	Revision            int
	ConfigHash          string
	BundleSchemaVersion int
	CreatedAt           time.Time
}

type ExecutionIdentityRepo struct{ db *sql.DB }

func NewExecutionIdentityRepo(db *sql.DB) *ExecutionIdentityRepo {
	return &ExecutionIdentityRepo{db: db}
}

// Bind inserts or verifies the immutable identity of one revision directory.
func (r *ExecutionIdentityRepo) Bind(ctx context.Context, requested ExecutionBinding) error {
	if err := validateExecutionBinding(requested); err != nil {
		return err
	}
	createdAt := requested.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("managed execution identity: begin bind: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
INSERT INTO revision_execution_identity(
    singleton, storage_id, deployment_id, revision, config_hash, bundle_schema_version, created_at
)
VALUES(1, ?, ?, ?, ?, ?, ?)
ON CONFLICT(singleton) DO NOTHING`,
		requested.StorageID,
		requested.DeploymentID,
		requested.Revision,
		requested.ConfigHash,
		requested.BundleSchemaVersion,
		unixNano(createdAt),
	)
	if err != nil {
		return fmt.Errorf("managed execution identity: insert binding: %w", err)
	}

	stored, err := readExecutionBinding(ctx, tx)
	if err != nil {
		return err
	}
	if !sameExecutionBinding(stored, requested) {
		return fmt.Errorf(
			"%w: stored storage %q deployment %q revision %d hash %s, requested storage %q deployment %q revision %d hash %s",
			ErrExecutionIdentityMismatch,
			stored.StorageID,
			stored.DeploymentID,
			stored.Revision,
			stored.ConfigHash,
			requested.StorageID,
			requested.DeploymentID,
			requested.Revision,
			requested.ConfigHash,
		)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("managed execution identity: commit bind: %w", err)
	}
	return nil
}

func readExecutionBinding(ctx context.Context, tx *sql.Tx) (ExecutionBinding, error) {
	var (
		stored    ExecutionBinding
		createdAt int64
	)
	err := tx.QueryRowContext(ctx, `
SELECT storage_id, deployment_id, revision, config_hash, bundle_schema_version, created_at
FROM revision_execution_identity WHERE singleton = 1`).Scan(
		&stored.StorageID,
		&stored.DeploymentID,
		&stored.Revision,
		&stored.ConfigHash,
		&stored.BundleSchemaVersion,
		&createdAt,
	)
	if err != nil {
		return ExecutionBinding{}, fmt.Errorf("managed execution identity: read binding: %w", err)
	}
	stored.CreatedAt = timeFromUnixNano(createdAt)
	if err := validateExecutionBinding(stored); err != nil {
		return ExecutionBinding{}, fmt.Errorf("managed execution identity: stored binding invalid: %w", err)
	}
	return stored, nil
}

func validateExecutionBinding(binding ExecutionBinding) error {
	if !lowerHexDigestRE.MatchString(binding.StorageID) {
		return fmt.Errorf("managed execution identity: storage id must be a lowercase sha256 digest")
	}
	if strings.TrimSpace(binding.DeploymentID) == "" {
		return fmt.Errorf("managed execution identity: deployment id is required")
	}
	if binding.Revision <= 0 || binding.BundleSchemaVersion <= 0 {
		return fmt.Errorf("managed execution identity: revision and bundle schema version must be positive")
	}
	if !lowerHexDigestRE.MatchString(binding.ConfigHash) {
		return fmt.Errorf("managed execution identity: config hash must be a lowercase sha256 digest")
	}
	return nil
}

func sameExecutionBinding(stored, requested ExecutionBinding) bool {
	return stored.StorageID == requested.StorageID &&
		stored.DeploymentID == requested.DeploymentID &&
		stored.Revision == requested.Revision &&
		stored.ConfigHash == requested.ConfigHash &&
		stored.BundleSchemaVersion == requested.BundleSchemaVersion
}
