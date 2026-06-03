package agent

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestChannelSinkConcurrentEmitsPreserveReceiveSeqOrder(t *testing.T) {
	t.Parallel()

	const (
		workers       = 32
		eventsPerWork = 16
		totalEvents   = workers * eventsPerWork
	)

	ch := make(chan StreamEvent, totalEvents)
	sink := NewChannelSink(context.Background(), "run-events", ch)

	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < eventsPerWork; j++ {
				sink.Emit(StreamEvent{Type: EventToolStarted})
			}
		}()
	}
	wg.Wait()
	sink.Close()

	var got []StreamEvent
	for e := range ch {
		got = append(got, e)
	}
	if len(got) != totalEvents {
		t.Fatalf("received %d events, want %d", len(got), totalEvents)
	}
	for i, e := range got {
		wantSeq := int64(i + 1)
		if e.Seq != wantSeq {
			t.Fatalf("event[%d].Seq = %d, want %d", i, e.Seq, wantSeq)
		}
	}
}

func TestChannelSinkBlockedEmitUnblocksOnCancelAndFutureEmitsReturn(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan StreamEvent, 1)
	sink := NewChannelSink(ctx, "run-blocked", ch)

	sink.Emit(StreamEvent{Type: EventRunStarted})

	blockedDone := make(chan struct{})
	go func() {
		sink.Emit(StreamEvent{Type: EventToolCompleted})
		close(blockedDone)
	}()

	select {
	case <-blockedDone:
		t.Fatal("non-status emit returned before context cancellation on a full channel")
	case <-time.After(25 * time.Millisecond):
	}

	cancel()

	select {
	case <-blockedDone:
	case <-time.After(time.Second):
		t.Fatal("blocked emit did not unblock after context cancellation")
	}

	futureDone := make(chan struct{})
	go func() {
		sink.Emit(StreamEvent{Type: EventToolFailed})
		close(futureDone)
	}()
	select {
	case <-futureDone:
	case <-time.After(time.Second):
		t.Fatal("future emit deadlocked after cancelled blocked emit")
	}
}
