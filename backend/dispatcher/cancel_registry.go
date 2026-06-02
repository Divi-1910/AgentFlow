package dispatcher

import (
	"sync"
	"time"
)

// DefaultCancelTTL is how long a sticky cancellation stays observable in the
// registry. It must outlast the window between a cancel being published and a
// late-dispatched child subscribing to the cancel topic / checking the
// registry — generous enough to cover realistic cascade settling.
const DefaultCancelTTL = 10 * time.Minute

// CancelRegistry records cancelled originator runs so a child that is
// dispatched but has not yet subscribed to the cancel topic still observes the
// cancellation (the dispatch→subscribe race). Entries are created only by
// Cancel and self-expire after a TTL, so clean runs never accumulate state and
// there is no Forget step (which previously raced with live siblings).
type CancelRegistry struct {
	ttl time.Duration
	mu  sync.Mutex
	at  map[string]time.Time
}

func NewCancelRegistry(ttl time.Duration) *CancelRegistry {
	if ttl <= 0 {
		ttl = DefaultCancelTTL
	}
	return &CancelRegistry{ttl: ttl, at: make(map[string]time.Time)}
}

func (r *CancelRegistry) Cancel(originatorRunID string) {
	if r == nil || originatorRunID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictLocked()
	r.at[originatorRunID] = time.Now()
}

func (r *CancelRegistry) IsCanceled(originatorRunID string) bool {
	if r == nil || originatorRunID == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.at[originatorRunID]
	if !ok {
		return false
	}
	if time.Since(t) > r.ttl {
		delete(r.at, originatorRunID)
		return false
	}
	return true
}

func (r *CancelRegistry) evictLocked() {
	for k, t := range r.at {
		if time.Since(t) > r.ttl {
			delete(r.at, k)
		}
	}
}
