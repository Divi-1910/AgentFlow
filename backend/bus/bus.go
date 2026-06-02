package bus

import (
	"context"
	"errors"
	"time"
)

var (
	ErrBusClosed          = errors.New("message bus closed")
	ErrRequestTimeout     = errors.New("request timed out")
	ErrSubscriptionClosed = errors.New("subscription closed")
)

// MessageBus is a topic-based switchboard for goroutines in the runner process.
type MessageBus interface {
	Publish(ctx context.Context, topic string, msg Message, opts ...PublishOption) error
	Subscribe(ctx context.Context, topic string, opts ...SubscribeOption) (Subscription, error)
	Request(ctx context.Context, topic string, msg Message, timeout time.Duration) (Message, error)
	Close() error
}

// Subscription receives messages for a single exact-match topic.
//
// Messages is intentionally never closed by the bus. Callers should watch Done
// alongside Messages to detect unsubscribe or bus shutdown.
type Subscription interface {
	Messages() <-chan Message
	Done() <-chan struct{}
	Topic() string
	Unsubscribe() error
}

// Message is the unit delivered through the bus.
//
// Publish sets Topic and, when Timestamp is zero, Timestamp. Message payloads
// are copied for each delivery so subscribers do not share mutable Body or
// Headers references.
type Message struct {
	Topic     string
	Headers   map[string]string
	Body      []byte
	ReplyTo   string
	CorrID    string
	Timestamp time.Time
}
