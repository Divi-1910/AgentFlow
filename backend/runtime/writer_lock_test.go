//go:build linux

package main

import (
	"errors"
	"os"
	"testing"
)

func TestManagedWriterLockIsExclusiveForProcessLifetime(t *testing.T) {
	metadataDir := t.TempDir()
	first, err := acquireManagedWriterLock(metadataDir)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := acquireManagedWriterLock(metadataDir); !errors.Is(err, errManagedStorageLocked) {
		t.Fatalf("second lock error = %v, want errManagedStorageLocked", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := acquireManagedWriterLock(metadataDir)
	if err != nil {
		t.Fatalf("lock after release failed: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	info, err := os.Stat(metadataDir + "/writer.lock")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("writer lock permissions = %o, want 600", info.Mode().Perm())
	}
}
