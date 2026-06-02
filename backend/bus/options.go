package bus

import "time"

const defaultBufferSize = 256

// SubscribeOption configures a subscription.
type SubscribeOption func(*subOptions)

type subOptions struct {
	bufferSize int
}

// WithBufferSize overrides the per-subscription channel buffer size.
//
// A zero value creates an unbuffered subscription. Negative values fall back to
// the default buffer size.
func WithBufferSize(n int) SubscribeOption {
	return func(opts *subOptions) {
		opts.bufferSize = n
	}
}

func resolveSubOptions(opts []SubscribeOption) subOptions {
	resolved := subOptions{bufferSize: defaultBufferSize}
	for _, opt := range opts {
		if opt != nil {
			opt(&resolved)
		}
	}
	if resolved.bufferSize < 0 {
		resolved.bufferSize = defaultBufferSize
	}
	return resolved
}

// PublishOption configures a single publish operation.
type PublishOption func(*pubOptions)

type pubOptions struct {
	perSubscriberTimeout time.Duration
	dropIfFull           bool
}

// WithSendTimeout limits how long Publish waits on each individual subscriber.
func WithSendTimeout(d time.Duration) PublishOption {
	return func(opts *pubOptions) {
		opts.perSubscriberTimeout = d
	}
}

// WithDropIfFull makes Publish skip subscribers whose message buffers are full.
func WithDropIfFull() PublishOption {
	return func(opts *pubOptions) {
		opts.dropIfFull = true
	}
}

func resolvePubOptions(opts []PublishOption) pubOptions {
	var resolved pubOptions
	for _, opt := range opts {
		if opt != nil {
			opt(&resolved)
		}
	}
	if resolved.perSubscriberTimeout < 0 {
		resolved.perSubscriberTimeout = 0
	}
	return resolved
}
