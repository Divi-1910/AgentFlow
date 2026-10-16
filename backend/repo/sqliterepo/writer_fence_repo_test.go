package sqliterepo

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestWriterFenceRepoClaimEnforcesMonotonicGeneration(t *testing.T) {
	db, err := OpenShared(filepath.Join(t.TempDir(), "shared.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := NewWriterFenceRepo(db)
	hash := strings.Repeat("a", 64)
	claim := WriterFenceClaim{
		Generation:        11,
		Revision:          7,
		ConfigHash:        hash,
		RuntimeInstanceID: "instance_" + strings.Repeat("b", 32),
	}
	if err := repo.Claim(context.Background(), claim); err != nil {
		t.Fatal(err)
	}

	restart := claim
	restart.RuntimeInstanceID = "instance_" + strings.Repeat("c", 32)
	if err := repo.Claim(context.Background(), restart); err != nil {
		t.Fatalf("same generation and identity restart failed: %v", err)
	}

	conflict := restart
	conflict.Revision = 8
	if err := repo.Claim(context.Background(), conflict); !errors.Is(err, ErrWriterGenerationConflict) {
		t.Fatalf("conflicting claim error = %v, want ErrWriterGenerationConflict", err)
	}
	conflict = restart
	conflict.ConfigHash = strings.Repeat("f", 64)
	if err := repo.Claim(context.Background(), conflict); !errors.Is(err, ErrWriterGenerationConflict) {
		t.Fatalf("conflicting config claim error = %v, want ErrWriterGenerationConflict", err)
	}

	newer := restart
	newer.Generation = 12
	newer.Revision = 8
	newer.RuntimeInstanceID = "instance_" + strings.Repeat("d", 32)
	if err := repo.Claim(context.Background(), newer); err != nil {
		t.Fatal(err)
	}
	if released, err := repo.Release(context.Background(), newer); err != nil || !released {
		t.Fatalf("Release() = %t, %v; want true, nil", released, err)
	}
	if err := repo.Claim(context.Background(), restart); !errors.Is(err, ErrWriterGenerationStale) {
		t.Fatalf("stale claim after release error = %v, want ErrWriterGenerationStale", err)
	}
}

func TestWriterFenceRepoReleaseRequiresOwningRuntimeInstance(t *testing.T) {
	db, err := OpenShared(filepath.Join(t.TempDir(), "shared.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := NewWriterFenceRepo(db)
	claim := WriterFenceClaim{
		Generation:        11,
		Revision:          7,
		ConfigHash:        strings.Repeat("a", 64),
		RuntimeInstanceID: "instance_" + strings.Repeat("b", 32),
	}
	if err := repo.Claim(context.Background(), claim); err != nil {
		t.Fatal(err)
	}

	nonOwner := claim
	nonOwner.RuntimeInstanceID = "instance_" + strings.Repeat("c", 32)
	if released, err := repo.Release(context.Background(), nonOwner); err != nil || released {
		t.Fatalf("non-owner Release() = %t, %v; want false, nil", released, err)
	}
	if released, err := repo.Release(context.Background(), claim); err != nil || !released {
		t.Fatalf("owner Release() = %t, %v; want true, nil", released, err)
	}
}

func TestWriterFenceRepoConcurrentClaimsNeverLowerMaximum(t *testing.T) {
	db, err := OpenShared(filepath.Join(t.TempDir(), "shared.db"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := NewWriterFenceRepo(db)
	hash := strings.Repeat("a", 64)

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	claims := []WriterFenceClaim{
		{
			Generation:        11,
			Revision:          11,
			ConfigHash:        hash,
			RuntimeInstanceID: "instance_" + strings.Repeat("b", 32),
		},
		{
			Generation:        12,
			Revision:          12,
			ConfigHash:        hash,
			RuntimeInstanceID: "instance_" + strings.Repeat("c", 32),
		},
	}
	for _, claim := range claims {
		claim := claim
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- repo.Claim(context.Background(), claim)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil && !errors.Is(err, ErrWriterGenerationStale) {
			t.Fatalf("concurrent Claim returned unexpected error: %v", err)
		}
	}

	err = repo.Claim(context.Background(), WriterFenceClaim{
		Generation:        11,
		Revision:          11,
		ConfigHash:        hash,
		RuntimeInstanceID: "instance_" + strings.Repeat("e", 32),
	})
	if !errors.Is(err, ErrWriterGenerationStale) {
		t.Fatalf("generation 11 after concurrent claims error = %v, want ErrWriterGenerationStale", err)
	}
}
