package pagination_test

import (
	"testing"
	"time"

	"backend/pagination"
)

func TestCursorRoundTripAndKindIsolation(t *testing.T) {
	t.Parallel()
	want := &pagination.Cursor{
		Kind: "threads", Time: time.Date(2026, 10, 24, 1, 2, 3, 4, time.UTC), ID: "record-9",
	}
	raw, err := pagination.Encode(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := pagination.Decode(raw, "threads")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != want.Kind || !got.Time.Equal(want.Time) || got.ID != want.ID {
		t.Fatalf("cursor = %+v, want %+v", got, want)
	}
	if _, err := pagination.Decode(raw, "runs"); err == nil {
		t.Fatal("thread cursor was accepted by the run collection")
	}
}

func TestLimitRejectsOutOfRangeValues(t *testing.T) {
	t.Parallel()
	if got, err := pagination.Limit(0, 50); err != nil || got != 50 {
		t.Fatalf("default limit = %d, %v", got, err)
	}
	for _, value := range []int{-1, pagination.MaxLimit + 1} {
		if _, err := pagination.Limit(value, 50); err == nil {
			t.Fatalf("limit %d was accepted", value)
		}
	}
}
