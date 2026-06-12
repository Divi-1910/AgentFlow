package dispatcher

import (
	"context"
	"sync"
)

type JobHub struct {
	mu      sync.Mutex
	waiters map[string][]chan struct{}
	wake    chan struct{}
}

func NewJobHub() *JobHub {
	return &JobHub{
		waiters: make(map[string][]chan struct{}),
		wake:    make(chan struct{}, 1),
	}
}

func (h *JobHub) Notify(jobID string) {
	if h == nil || jobID == "" {
		return
	}
	h.mu.Lock()
	waiters := h.waiters[jobID]
	delete(h.waiters, jobID)
	h.mu.Unlock()
	for _, ch := range waiters {
		close(ch)
	}
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

func (h *JobHub) Wake() <-chan struct{} {
	if h == nil {
		return nil
	}
	return h.wake
}

func (h *JobHub) Wait(ctx context.Context, jobID string) error {
	if h == nil || jobID == "" {
		return ctx.Err()
	}
	ch := make(chan struct{})
	h.mu.Lock()
	h.waiters[jobID] = append(h.waiters[jobID], ch)
	h.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		h.remove(jobID, ch)
		return ctx.Err()
	}
}

func (h *JobHub) remove(jobID string, ch chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	waiters := h.waiters[jobID]
	for i, w := range waiters {
		if w == ch {
			waiters = append(waiters[:i], waiters[i+1:]...)
			break
		}
	}
	if len(waiters) == 0 {
		delete(h.waiters, jobID)
		return
	}
	h.waiters[jobID] = waiters
}
