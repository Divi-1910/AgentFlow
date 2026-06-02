package bus

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// InProcBus is a channel-backed MessageBus for a single Go process.
//
// Topics are exact-match strings. Delivery is broadcast: every subscription on
// a topic receives each published message. Work-pool callers should share one
// subscription across workers if they want queue-like competing consumers.
type InProcBus struct {
	mu          sync.RWMutex
	subscribers map[string][]*subscription
	closed      atomic.Bool
}

type subscription struct {
	topic    string
	ch       chan Message
	done     chan struct{}
	doneOnce sync.Once
	bus      *InProcBus
}

// NewInProc creates an empty in-process message bus.
func NewInProc() *InProcBus {
	return &InProcBus{
		subscribers: make(map[string][]*subscription),
	}
}

func (b *InProcBus) Publish(ctx context.Context, topic string, msg Message, opts ...PublishOption) error {
	if b.closed.Load() {
		return ErrBusClosed
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	pubOpts := resolvePubOptions(opts)
	msg.Topic = topic
	if msg.Timestamp.IsZero() {
		msg.Timestamp = time.Now().UTC()
	}

	b.mu.RLock()
	if b.closed.Load() {
		b.mu.RUnlock()
		return ErrBusClosed
	}
	subs := append([]*subscription(nil), b.subscribers[topic]...)
	b.mu.RUnlock()

	for _, sub := range subs {
		if err := deliverOne(ctx, sub, msg, pubOpts); err != nil {
			return err
		}
	}
	return nil
}

func deliverOne(ctx context.Context, sub *subscription, msg Message, opts pubOptions) error {
	select {
	case <-sub.done:
		return nil
	default:
	}

	if opts.dropIfFull {
		select {
		case sub.ch <- cloneMessage(msg):
			return nil
		case <-sub.done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}

	if opts.perSubscriberTimeout > 0 {
		timer := time.NewTimer(opts.perSubscriberTimeout)
		defer timer.Stop()

		select {
		case sub.ch <- cloneMessage(msg):
			return nil
		case <-sub.done:
			return nil
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	select {
	case sub.ch <- cloneMessage(msg):
		return nil
	case <-sub.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *InProcBus) Subscribe(ctx context.Context, topic string, opts ...SubscribeOption) (Subscription, error) {
	if b.closed.Load() {
		return nil, ErrBusClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	subOpts := resolveSubOptions(opts)
	sub := &subscription{
		topic: topic,
		ch:    make(chan Message, subOpts.bufferSize),
		done:  make(chan struct{}),
		bus:   b,
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed.Load() {
		return nil, ErrBusClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if b.subscribers == nil {
		b.subscribers = make(map[string][]*subscription)
	}
	b.subscribers[topic] = append(b.subscribers[topic], sub)
	return sub, nil
}

func (b *InProcBus) Request(ctx context.Context, topic string, msg Message, timeout time.Duration) (Message, error) {
	waitCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		waitCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	corr := uuid.NewString()
	replyTopic := "reply." + corr
	sub, err := b.Subscribe(waitCtx, replyTopic)
	if err != nil {
		return Message{}, requestErr(ctx, waitCtx, timeout, err)
	}
	defer sub.Unsubscribe()

	msg.ReplyTo = replyTopic
	msg.CorrID = corr
	if err := b.Publish(waitCtx, topic, msg); err != nil {
		return Message{}, requestErr(ctx, waitCtx, timeout, err)
	}

	select {
	case reply := <-sub.Messages():
		return reply, nil
	case <-sub.Done():
		return Message{}, ErrSubscriptionClosed
	case <-waitCtx.Done():
		return Message{}, requestErr(ctx, waitCtx, timeout, waitCtx.Err())
	}
}

func requestErr(parent, waitCtx context.Context, timeout time.Duration, err error) error {
	if timeout > 0 && errors.Is(err, context.DeadlineExceeded) && parent.Err() == nil {
		return ErrRequestTimeout
	}
	if waitCtx.Err() != nil && parent.Err() != nil {
		return parent.Err()
	}
	return err
}

func (b *InProcBus) Close() error {
	if !b.closed.CompareAndSwap(false, true) {
		return ErrBusClosed
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	for _, subs := range b.subscribers {
		for _, sub := range subs {
			sub.doneOnce.Do(func() {
				close(sub.done)
			})
		}
	}
	b.subscribers = make(map[string][]*subscription)
	return nil
}

func (b *InProcBus) removeSub(sub *subscription) {
	if sub == nil {
		return
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	subs := b.subscribers[sub.topic]
	for i, candidate := range subs {
		if candidate != sub {
			continue
		}
		if len(subs) == 1 {
			delete(b.subscribers, sub.topic)
			return
		}
		copy(subs[i:], subs[i+1:])
		subs[len(subs)-1] = nil // help GC reclaim the removed subscription
		b.subscribers[sub.topic] = subs[:len(subs)-1]
		return
	}
}

func (s *subscription) Messages() <-chan Message {
	return s.ch
}

func (s *subscription) Done() <-chan struct{} {
	return s.done
}

func (s *subscription) Topic() string {
	return s.topic
}

func (s *subscription) Unsubscribe() error {
	s.doneOnce.Do(func() {
		close(s.done)
	})
	if s.bus != nil {
		s.bus.removeSub(s)
	}
	return nil
}

func cloneMessage(msg Message) Message {
	if msg.Headers != nil {
		headers := make(map[string]string, len(msg.Headers))
		for k, v := range msg.Headers {
			headers[k] = v
		}
		msg.Headers = headers
	}
	if msg.Body != nil {
		body := make([]byte, len(msg.Body))
		copy(body, msg.Body)
		msg.Body = body
	}
	return msg
}
