package agent

import "sync"

const taskEventSubscriberBuffer = 512

// TaskEventSubscription observes every runtime source that belongs to one
// originator task. Closing it only detaches the observer; it does not cancel
// any run in the task tree.
type TaskEventSubscription struct {
	Events <-chan StreamEvent
	close  func()
	once   sync.Once
}

func (s *TaskEventSubscription) Close() {
	if s == nil || s.close == nil {
		return
	}
	s.once.Do(s.close)
}

// TaskEventHub is the process-local fan-in boundary for events produced by
// child agents, async jobs, callbacks, and coordinator-started resumptions.
// The durable run/message stores remain the source of truth; this hub supplies
// live observability to the reconnectable ExecutionRegistry.
//
// AgentFlow runs one runtime process per deployed agent/team, and Studio uses
// one process for its in-process bus, so a process-local hub covers the current
// deployment boundary without introducing a second durable event system.
type TaskEventHub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[string]map[uint64]chan StreamEvent
}

func NewTaskEventHub() *TaskEventHub {
	return &TaskEventHub{subscribers: make(map[string]map[uint64]chan StreamEvent)}
}

func (h *TaskEventHub) Subscribe(originatorRunID string) *TaskEventSubscription {
	if h == nil || originatorRunID == "" {
		return nil
	}
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	ch := make(chan StreamEvent, taskEventSubscriberBuffer)
	byTask := h.subscribers[originatorRunID]
	if byTask == nil {
		byTask = make(map[uint64]chan StreamEvent)
		h.subscribers[originatorRunID] = byTask
	}
	byTask[id] = ch
	h.mu.Unlock()

	return &TaskEventSubscription{
		Events: ch,
		close: func() {
			h.mu.Lock()
			if current := h.subscribers[originatorRunID]; current != nil {
				if subscriber, ok := current[id]; ok {
					delete(current, id)
					close(subscriber)
				}
				if len(current) == 0 {
					delete(h.subscribers, originatorRunID)
				}
			}
			h.mu.Unlock()
		},
	}
}

func (h *TaskEventHub) Publish(event StreamEvent) {
	if h == nil {
		return
	}
	originatorRunID := event.OriginatorRunID
	if originatorRunID == "" {
		originatorRunID = event.RunID
		event.OriginatorRunID = originatorRunID
	}
	if originatorRunID == "" {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	for id, subscriber := range h.subscribers[originatorRunID] {
		select {
		case subscriber <- event:
		default:
			// A stalled aggregate observer must not backpressure agent execution.
			// Detach it; the registry's own bounded replay remains available for
			// healthy HTTP observers downstream.
			delete(h.subscribers[originatorRunID], id)
			close(subscriber)
		}
	}
	if len(h.subscribers[originatorRunID]) == 0 {
		delete(h.subscribers, originatorRunID)
	}
}
