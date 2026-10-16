package sqliterepo

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStorageIdentityRepoBindPreservesFirstPrincipal(t *testing.T) {
	db, err := OpenShared(filepath.Join(t.TempDir(), "shared.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	repo := NewStorageIdentityRepo(db)
	createdAt := time.Date(2026, time.October, 15, 12, 0, 0, 0, time.UTC)
	first, err := repo.Bind(context.Background(), StorageBinding{
		StorageID:          strings.Repeat("a", 64),
		DeploymentID:       "deployment-1",
		RuntimePrincipalID: "runtime_" + strings.Repeat("b", 32),
		CreatedAt:          createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}

	reopened, err := repo.Bind(context.Background(), StorageBinding{
		StorageID:          strings.Repeat("a", 64),
		DeploymentID:       "deployment-1",
		RuntimePrincipalID: "runtime_" + strings.Repeat("c", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reopened.RuntimePrincipalID != first.RuntimePrincipalID {
		t.Fatalf("runtime principal = %q, want original %q", reopened.RuntimePrincipalID, first.RuntimePrincipalID)
	}
	if !reopened.CreatedAt.Equal(createdAt) {
		t.Fatalf("created at = %v, want %v", reopened.CreatedAt, createdAt)
	}
}

func TestStorageIdentityRepoBindRejectsDifferentStorage(t *testing.T) {
	db, err := OpenShared(filepath.Join(t.TempDir(), "shared.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := NewStorageIdentityRepo(db)
	binding := StorageBinding{
		StorageID:          strings.Repeat("a", 64),
		DeploymentID:       "deployment-1",
		RuntimePrincipalID: "runtime_" + strings.Repeat("b", 32),
	}
	if _, err := repo.Bind(context.Background(), binding); err != nil {
		t.Fatal(err)
	}
	binding.StorageID = strings.Repeat("d", 64)
	if _, err := repo.Bind(context.Background(), binding); !errors.Is(err, ErrStorageIdentityMismatch) {
		t.Fatalf("Bind error = %v, want ErrStorageIdentityMismatch", err)
	}
}

func TestExecutionIdentityRepoBindVerifiesExactRevisionIdentity(t *testing.T) {
	db, err := OpenExecution(filepath.Join(t.TempDir(), "execution.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := NewExecutionIdentityRepo(db)
	binding := ExecutionBinding{
		StorageID:           strings.Repeat("a", 64),
		DeploymentID:        "deployment-1",
		Revision:            7,
		ConfigHash:          strings.Repeat("b", 64),
		BundleSchemaVersion: 1,
	}
	if err := repo.Bind(context.Background(), binding); err != nil {
		t.Fatal(err)
	}
	if err := repo.Bind(context.Background(), binding); err != nil {
		t.Fatalf("same binding was not idempotent: %v", err)
	}

	binding.Revision = 8
	if err := repo.Bind(context.Background(), binding); !errors.Is(err, ErrExecutionIdentityMismatch) {
		t.Fatalf("Bind error = %v, want ErrExecutionIdentityMismatch", err)
	}
}
