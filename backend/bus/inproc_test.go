package bus

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPublishSubscribe_BasicRoundTrip(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub := mustSubscribe(t, b, "tasks")

	err := b.Publish(context.Background(), "tasks", Message{Body: []byte("hello")})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	got := mustReceive(t, sub.Messages(), time.Second)
	if got.Topic != "tasks" {
		t.Fatalf("Topic = %q, want tasks", got.Topic)
	}
	if string(got.Body) != "hello" {
		t.Fatalf("Body = %q, want hello", got.Body)
	}
	if got.Timestamp.IsZero() {
		t.Fatal("Timestamp was not set")
	}
}

func TestPublishSubscribe_MultipleSubsAllReceive(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub1 := mustSubscribe(t, b, "events")
	sub2 := mustSubscribe(t, b, "events")

	err := b.Publish(context.Background(), "events", Message{Body: []byte("fanout")})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	if got := mustReceive(t, sub1.Messages(), time.Second); string(got.Body) != "fanout" {
		t.Fatalf("sub1 Body = %q, want fanout", got.Body)
	}
	if got := mustReceive(t, sub2.Messages(), time.Second); string(got.Body) != "fanout" {
		t.Fatalf("sub2 Body = %q, want fanout", got.Body)
	}
}

func TestPublishSubscribe_UnsubscribedSubStopsReceiving(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub := mustSubscribe(t, b, "dispatch")
	if err := sub.Unsubscribe(); err != nil {
		t.Fatalf("Unsubscribe() error = %v", err)
	}

	err := b.Publish(context.Background(), "dispatch", Message{Body: []byte("late")})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	assertNoReceive(t, sub.Messages(), 75*time.Millisecond)
}

func TestSubscribe_LateSubscriberMissesEarlierMessages(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	err := b.Publish(context.Background(), "topic", Message{Body: []byte("before")})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	sub := mustSubscribe(t, b, "topic")
	assertNoReceive(t, sub.Messages(), 75*time.Millisecond)

	err = b.Publish(context.Background(), "topic", Message{Body: []byte("after")})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	got := mustReceive(t, sub.Messages(), time.Second)
	if string(got.Body) != "after" {
		t.Fatalf("Body = %q, want after", got.Body)
	}
}

func TestSubscribe_BufferedSlowSubDoesNotBlockOthers(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	_ = mustSubscribe(t, b, "events", WithBufferSize(1))
	fast := mustSubscribe(t, b, "events", WithBufferSize(1))

	err := b.Publish(context.Background(), "events", Message{Body: []byte("one")})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	got := mustReceive(t, fast.Messages(), time.Second)
	if string(got.Body) != "one" {
		t.Fatalf("Body = %q, want one", got.Body)
	}
}

func TestPublish_DefaultBlocksWhenBufferFull(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub := mustSubscribe(t, b, "blocked", WithBufferSize(1))

	if err := b.Publish(context.Background(), "blocked", Message{Body: []byte("first")}); err != nil {
		t.Fatalf("first Publish() error = %v", err)
	}

	started := make(chan struct{})
	errCh := make(chan error, 1)
	go func() {
		close(started)
		errCh <- b.Publish(context.Background(), "blocked", Message{Body: []byte("second")})
	}()

	<-started
	select {
	case err := <-errCh:
		t.Fatalf("Publish() completed while buffer was full: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	if got := mustReceive(t, sub.Messages(), time.Second); string(got.Body) != "first" {
		t.Fatalf("first Body = %q, want first", got.Body)
	}
	if err := mustReceiveErr(t, errCh, time.Second); err != nil {
		t.Fatalf("second Publish() error = %v", err)
	}
	if got := mustReceive(t, sub.Messages(), time.Second); string(got.Body) != "second" {
		t.Fatalf("second Body = %q, want second", got.Body)
	}
}

func TestPublish_DropIfFullSkipsBlocked(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	slow := mustSubscribe(t, b, "drops", WithBufferSize(1))
	fast := mustSubscribe(t, b, "drops", WithBufferSize(2))

	if err := b.Publish(context.Background(), "drops", Message{Body: []byte("first")}); err != nil {
		t.Fatalf("first Publish() error = %v", err)
	}
	if err := b.Publish(context.Background(), "drops", Message{Body: []byte("second")}, WithDropIfFull()); err != nil {
		t.Fatalf("second Publish() error = %v", err)
	}

	if got := mustReceive(t, fast.Messages(), time.Second); string(got.Body) != "first" {
		t.Fatalf("fast first Body = %q, want first", got.Body)
	}
	if got := mustReceive(t, fast.Messages(), time.Second); string(got.Body) != "second" {
		t.Fatalf("fast second Body = %q, want second", got.Body)
	}
	if got := mustReceive(t, slow.Messages(), time.Second); string(got.Body) != "first" {
		t.Fatalf("slow Body = %q, want first", got.Body)
	}
	assertNoReceive(t, slow.Messages(), 75*time.Millisecond)
}

func TestPublish_SendTimeoutSkipsSlow(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	slow := mustSubscribe(t, b, "timeouts", WithBufferSize(1))
	fast := mustSubscribe(t, b, "timeouts", WithBufferSize(2))

	if err := b.Publish(context.Background(), "timeouts", Message{Body: []byte("first")}); err != nil {
		t.Fatalf("first Publish() error = %v", err)
	}
	if err := b.Publish(context.Background(), "timeouts", Message{Body: []byte("second")}, WithSendTimeout(25*time.Millisecond)); err != nil {
		t.Fatalf("second Publish() error = %v", err)
	}

	if got := mustReceive(t, fast.Messages(), time.Second); string(got.Body) != "first" {
		t.Fatalf("fast first Body = %q, want first", got.Body)
	}
	if got := mustReceive(t, fast.Messages(), time.Second); string(got.Body) != "second" {
		t.Fatalf("fast second Body = %q, want second", got.Body)
	}
	if got := mustReceive(t, slow.Messages(), time.Second); string(got.Body) != "first" {
		t.Fatalf("slow Body = %q, want first", got.Body)
	}
	assertNoReceive(t, slow.Messages(), 75*time.Millisecond)
}

func TestPublish_ContextCancelAborts(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := b.Publish(ctx, "topic", Message{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Publish() error = %v, want context.Canceled", err)
	}
}

func TestRequest_RoundTripReturnsReply(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	target := mustSubscribe(t, b, "echo")
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case msg := <-target.Messages():
			_ = b.Publish(context.Background(), msg.ReplyTo, Message{
				CorrID: msg.CorrID,
				Body:   []byte("pong"),
			})
		case <-target.Done():
		}
	}()

	reply, err := b.Request(context.Background(), "echo", Message{Body: []byte("ping")}, time.Second)
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	if string(reply.Body) != "pong" {
		t.Fatalf("reply Body = %q, want pong", reply.Body)
	}
	mustClose(t, done, time.Second)
}

func TestRequest_TimeoutWhenNoResponder(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	_, err := b.Request(context.Background(), "missing", Message{}, 30*time.Millisecond)
	if !errors.Is(err, ErrRequestTimeout) {
		t.Fatalf("Request() error = %v, want ErrRequestTimeout", err)
	}
}

func TestRequest_TimeoutCoversBlockedPublish(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	_ = mustSubscribe(t, b, "rpc", WithBufferSize(1))
	if err := b.Publish(context.Background(), "rpc", Message{Body: []byte("fill")}); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	_, err := b.Request(context.Background(), "rpc", Message{}, 30*time.Millisecond)
	if !errors.Is(err, ErrRequestTimeout) {
		t.Fatalf("Request() error = %v, want ErrRequestTimeout", err)
	}
}

func TestRequest_CorrIDPropagated(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	target := mustSubscribe(t, b, "rpc")
	seen := make(chan Message, 1)
	go func() {
		select {
		case msg := <-target.Messages():
			seen <- msg
			_ = b.Publish(context.Background(), msg.ReplyTo, Message{CorrID: msg.CorrID})
		case <-target.Done():
		}
	}()

	reply, err := b.Request(context.Background(), "rpc", Message{}, time.Second)
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	req := mustReceive(t, seen, time.Second)
	if req.CorrID == "" {
		t.Fatal("request CorrID was empty")
	}
	if reply.CorrID != req.CorrID {
		t.Fatalf("reply CorrID = %q, want %q", reply.CorrID, req.CorrID)
	}
}

func TestRequest_ReplyToSetCorrectly(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	target := mustSubscribe(t, b, "rpc")
	seen := make(chan Message, 1)
	go func() {
		select {
		case msg := <-target.Messages():
			seen <- msg
			_ = b.Publish(context.Background(), msg.ReplyTo, Message{CorrID: msg.CorrID})
		case <-target.Done():
		}
	}()

	_, err := b.Request(context.Background(), "rpc", Message{}, time.Second)
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	req := mustReceive(t, seen, time.Second)
	want := "reply." + req.CorrID
	if req.ReplyTo != want {
		t.Fatalf("ReplyTo = %q, want %q", req.ReplyTo, want)
	}
}

func TestRequest_ContextCancelAborts(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := b.Request(ctx, "rpc", Message{}, time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Request() error = %v, want context.Canceled", err)
	}
}

func TestClose_FailsSubsequentPublishAndSubscribe(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	if err := b.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	if err := b.Publish(context.Background(), "topic", Message{}); !errors.Is(err, ErrBusClosed) {
		t.Fatalf("Publish() error = %v, want ErrBusClosed", err)
	}
	if _, err := b.Subscribe(context.Background(), "topic"); !errors.Is(err, ErrBusClosed) {
		t.Fatalf("Subscribe() error = %v, want ErrBusClosed", err)
	}
	if err := b.Close(); !errors.Is(err, ErrBusClosed) {
		t.Fatalf("second Close() error = %v, want ErrBusClosed", err)
	}
}

func TestClose_CausesActiveSubsToSeeDone(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub := mustSubscribe(t, b, "topic")
	if err := b.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	select {
	case <-sub.Done():
	case <-time.After(time.Second):
		t.Fatal("subscription Done() did not close")
	}
}

func TestUnsubscribe_Idempotent(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub := mustSubscribe(t, b, "topic")

	if err := sub.Unsubscribe(); err != nil {
		t.Fatalf("first Unsubscribe() error = %v", err)
	}
	if err := sub.Unsubscribe(); err != nil {
		t.Fatalf("second Unsubscribe() error = %v", err)
	}
	select {
	case <-sub.Done():
	default:
		t.Fatal("Done() was not closed")
	}
}

func TestConcurrent_PubSubUnsubscribeRace(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	errCh := make(chan error, 100)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%3 == 0 {
				sub, err := b.Subscribe(ctx, "race", WithBufferSize(8))
				if err != nil {
					if ctx.Err() == nil {
						errCh <- err
					}
					return
				}
				defer sub.Unsubscribe()

				deadline := time.After(25 * time.Millisecond)
				for {
					select {
					case <-sub.Messages():
					case <-sub.Done():
						return
					case <-deadline:
						return
					case <-ctx.Done():
						return
					}
				}
			}

			for j := 0; j < 25; j++ {
				err := b.Publish(ctx, "race", Message{Body: []byte{byte(i), byte(j)}}, WithDropIfFull())
				if err != nil {
					if ctx.Err() == nil {
						errCh <- err
					}
					return
				}
			}
		}()
	}

	waitGroupDone(t, &wg, 3*time.Second)
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent operation error = %v", err)
	}
}

func TestConcurrent_RequestReplyManyRequesters(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var responders sync.WaitGroup
	for i := 0; i < 4; i++ {
		sub := mustSubscribe(t, b, "rpc", WithBufferSize(64))
		responders.Add(1)
		go func() {
			defer responders.Done()
			for {
				select {
				case msg := <-sub.Messages():
					_ = b.Publish(ctx, msg.ReplyTo, Message{
						CorrID: msg.CorrID,
						Body:   []byte(msg.CorrID),
					}, WithSendTimeout(100*time.Millisecond))
				case <-sub.Done():
					return
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	errCh := make(chan error, 40)
	var requesters sync.WaitGroup
	for i := 0; i < 40; i++ {
		requesters.Add(1)
		go func() {
			defer requesters.Done()
			reply, err := b.Request(context.Background(), "rpc", Message{}, time.Second)
			if err != nil {
				errCh <- err
				return
			}
			if reply.CorrID == "" {
				errCh <- errors.New("empty reply CorrID")
				return
			}
			if string(reply.Body) != reply.CorrID {
				errCh <- fmt.Errorf("reply body %q does not match CorrID %q", reply.Body, reply.CorrID)
			}
		}()
	}

	waitGroupDone(t, &requesters, 3*time.Second)
	close(errCh)
	for err := range errCh {
		t.Fatalf("requester error = %v", err)
	}

	cancel()
	waitGroupDone(t, &responders, time.Second)
}

func TestConcurrent_PublishWhileUnsubscribe(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub := mustSubscribe(t, b, "edge", WithBufferSize(1))

	stop := make(chan struct{})
	done := make(chan error, 1)
	var published atomic.Int64
	go func() {
		for {
			select {
			case <-stop:
				done <- nil
				return
			default:
			}
			if err := b.Publish(context.Background(), "edge", Message{}, WithDropIfFull()); err != nil {
				done <- err
				return
			}
			published.Add(1)
		}
	}()

	assertEventually(t, func() bool {
		return published.Load() > 0
	}, time.Second)
	if err := sub.Unsubscribe(); err != nil {
		t.Fatalf("Unsubscribe() error = %v", err)
	}
	close(stop)
	if err := mustReceiveErr(t, done, time.Second); err != nil {
		t.Fatalf("publish loop error = %v", err)
	}
}

func TestNoLeakOnUnsubscribe(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	for i := 0; i < 1000; i++ {
		sub := mustSubscribe(t, b, "leaks")
		if err := sub.Unsubscribe(); err != nil {
			t.Fatalf("Unsubscribe() error = %v", err)
		}
	}

	b.mu.RLock()
	subs, ok := b.subscribers["leaks"]
	b.mu.RUnlock()
	if ok || len(subs) != 0 {
		t.Fatalf("subscribers[leaks] = %v, %v; want no entry", subs, ok)
	}
}

// TestRemoveSub_NilsOutTailToHelpGC pins the GC-hygiene fix in removeSub:
// after removing a subscription from the middle of a multi-subscription
// topic, the orphan slot at the underlying array's tail must be cleared.
// Without that, the trimmed slice's backing array continues to reference
// the removed *subscription, preventing the runtime from reclaiming it.
func TestRemoveSub_NilsOutTailToHelpGC(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	subs := make([]Subscription, 3)
	for i := range subs {
		subs[i] = mustSubscribe(t, b, "tail")
	}

	if err := subs[0].Unsubscribe(); err != nil {
		t.Fatalf("Unsubscribe() error = %v", err)
	}

	b.mu.RLock()
	list, ok := b.subscribers["tail"]
	if !ok {
		b.mu.RUnlock()
		t.Fatalf("subscribers[tail] is missing; expected the topic to remain with 2 subs")
	}
	if len(list) != 2 {
		b.mu.RUnlock()
		t.Fatalf("len(subscribers[tail]) = %d, want 2", len(list))
	}
	// Re-slice through the backing array to inspect the now-orphan slot.
	backing := list[:cap(list)]
	tail := backing[len(list)]
	b.mu.RUnlock()
	if tail != nil {
		t.Fatalf("orphan tail slot is not nil — backing array still references the removed *subscription, GC cannot reclaim it")
	}
}

func TestPublish_MessagePayloadCopiedForSubscribers(t *testing.T) {
	t.Parallel()

	b := newTestBus(t)
	sub1 := mustSubscribe(t, b, "copy")
	sub2 := mustSubscribe(t, b, "copy")

	msg := Message{
		Headers: map[string]string{"k": "v"},
		Body:    []byte("body"),
	}
	if err := b.Publish(context.Background(), "copy", msg); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	got1 := mustReceive(t, sub1.Messages(), time.Second)
	got2 := mustReceive(t, sub2.Messages(), time.Second)
	got1.Headers["k"] = "changed"
	got1.Body[0] = 'x'

	if got2.Headers["k"] != "v" {
		t.Fatalf("second subscriber header = %q, want v", got2.Headers["k"])
	}
	if string(got2.Body) != "body" {
		t.Fatalf("second subscriber body = %q, want body", got2.Body)
	}
}

func newTestBus(t *testing.T) *InProcBus {
	t.Helper()
	b := NewInProc()
	t.Cleanup(func() {
		_ = b.Close()
	})
	return b
}

func mustSubscribe(t *testing.T, b *InProcBus, topic string, opts ...SubscribeOption) Subscription {
	t.Helper()
	sub, err := b.Subscribe(context.Background(), topic, opts...)
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	return sub
}

func mustReceive(t *testing.T, ch <-chan Message, timeout time.Duration) Message {
	t.Helper()
	select {
	case msg := <-ch:
		return msg
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for message")
		return Message{}
	}
}

func assertNoReceive(t *testing.T, ch <-chan Message, timeout time.Duration) {
	t.Helper()
	select {
	case msg := <-ch:
		t.Fatalf("unexpected message: %+v", msg)
	case <-time.After(timeout):
	}
}

func mustReceiveErr(t *testing.T, ch <-chan error, timeout time.Duration) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for error result")
		return nil
	}
}

func assertEventually(t *testing.T, cond func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	if cond() {
		return
	}
	t.Fatal("condition did not become true")
}

func mustClose(t *testing.T, ch <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(timeout):
		t.Fatal("timed out waiting for channel close")
	}
}

func waitGroupDone(t *testing.T, wg *sync.WaitGroup, timeout time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	mustClose(t, done, timeout)
}
