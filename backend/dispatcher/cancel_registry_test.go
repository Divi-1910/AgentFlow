package dispatcher

import (
	"testing"
	"time"
)

func TestCancelRegistry_StickyWithinTTL(t *testing.T) {
	t.Parallel()
	r := NewCancelRegistry(time.Minute)
	r.Cancel("orig-1")
	if !r.IsCanceled("orig-1") {
		t.Fatal("cancellation should be observable within the TTL")
	}
	// A different originator is unaffected.
	if r.IsCanceled("orig-2") {
		t.Fatal("unrelated originator should not be cancelled")
	}
}

func TestCancelRegistry_ExpiresAfterTTL(t *testing.T) {
	t.Parallel()
	r := NewCancelRegistry(20 * time.Millisecond)
	r.Cancel("orig-1")
	if !r.IsCanceled("orig-1") {
		t.Fatal("should be cancelled immediately after Cancel")
	}
	time.Sleep(40 * time.Millisecond)
	if r.IsCanceled("orig-1") {
		t.Fatal("cancellation should self-expire past the TTL")
	}
}

func TestCancelRegistry_CleanRunsCreateNoEntries(t *testing.T) {
	t.Parallel()
	r := NewCancelRegistry(time.Minute)
	// Never cancelled → never present. (No Forget API to race with siblings.)
	if r.IsCanceled("never-cancelled") {
		t.Fatal("an uncancelled originator must report not-cancelled")
	}
}
