package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"backend/agent"
)

const (
	executionEventBufferSize  = 2048
	executionSubscriberBuffer = 128
	executionSessionTTL       = 5 * time.Minute
)

// ExecutionSubscription is one observer of a runtime-owned execution. Closing
// a subscription only detaches that observer; it never cancels the execution.
type ExecutionSubscription struct {
	Events <-chan agent.StreamEvent
	close  func()
	once   sync.Once
}

func (s *ExecutionSubscription) Close() {
	if s == nil {
		return
	}
	if s.close != nil {
		s.once.Do(s.close)
	}
}

type executionSession struct {
	mu sync.Mutex

	runID       string
	cancel      context.CancelFunc
	done        chan struct{}
	events      []agent.StreamEvent
	nextSeq     int64
	nextSubID   uint64
	subscribers map[uint64]chan agent.StreamEvent
	finished    bool
	waiting     bool
	taskSub     *agent.TaskEventSubscription
	doneOnce    sync.Once
	onFinished  func(*executionSession)
}

// ExecutionRegistry owns top-level executions running in this process. Its
// contexts are rooted in the application lifetime, not in any HTTP request,
// so a browser disconnect only removes a subscriber and cannot stop the run.
// Durable run state remains owned by the run repository; this registry only
// supplies process-local execution control and a bounded reconnect buffer.
type ExecutionRegistry struct {
	mu         sync.Mutex
	root       context.Context
	entries    map[string]*executionSession
	retention  time.Duration
	taskEvents *agent.TaskEventHub
}

func NewExecutionRegistry(parents ...context.Context) *ExecutionRegistry {
	root := context.Background()
	if len(parents) > 0 && parents[0] != nil {
		root = parents[0]
	}
	return &ExecutionRegistry{
		root:      root,
		entries:   make(map[string]*executionSession),
		retention: executionSessionTTL,
	}
}

// NewExecutionRegistryWithTaskEvents attaches the reconnectable root stream
// to the application-level originator event hub. The handler-owned root
// attempt and every child/coordinator source therefore share one delivery
// sequence without changing their source RunID/Seq identities.
func NewExecutionRegistryWithTaskEvents(root context.Context, taskEvents *agent.TaskEventHub) *ExecutionRegistry {
	registry := NewExecutionRegistry(root)
	registry.taskEvents = taskEvents
	return registry
}

// Start creates a runtime-owned execution for runID. A completed retained
// session may be replaced by a new attempt (resume), but an active session is
// returned unchanged so two callers cannot execute the same run concurrently.
func (r *ExecutionRegistry) Start(
	runID string,
	execute func(context.Context, func(agent.StreamEvent)),
) (bool, error) {
	if r == nil {
		return false, fmt.Errorf("execution registry is nil")
	}
	if runID == "" {
		return false, fmt.Errorf("run id is required")
	}
	if execute == nil {
		return false, fmt.Errorf("execution function is required")
	}

	r.mu.Lock()
	nextSeq := int64(1)
	retainedEvents := make([]agent.StreamEvent, 0, executionEventBufferSize)
	if current, ok := r.entries[runID]; ok {
		current.mu.Lock()
		finished := current.finished
		if finished {
			nextSeq = current.nextSeq
			retainedEvents = append(retainedEvents, current.events...)
		}
		current.mu.Unlock()
		if !finished {
			r.mu.Unlock()
			return false, nil
		}
	}
	runCtx, cancel := context.WithCancel(r.root)
	session := &executionSession{
		runID:       runID,
		cancel:      cancel,
		done:        make(chan struct{}),
		events:      retainedEvents,
		nextSeq:     nextSeq,
		subscribers: make(map[uint64]chan agent.StreamEvent),
	}
	if r.taskEvents != nil {
		session.taskSub = r.taskEvents.Subscribe(runID)
	}
	session.onFinished = func(completed *executionSession) {
		time.AfterFunc(r.retention, func() {
			r.mu.Lock()
			if current, ok := r.entries[runID]; ok && current == completed {
				delete(r.entries, runID)
			}
			r.mu.Unlock()
		})
	}
	r.entries[runID] = session
	r.mu.Unlock()

	if session.taskSub != nil {
		go session.forwardTaskEvents()
	}
	go func() {
		select {
		case <-runCtx.Done():
			session.finish()
		case <-session.done:
		}
	}()

	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("panic in runtime-owned execution", "run_id", runID, "error", recovered)
				session.publish(agent.StreamEvent{
					Type:  agent.EventRunFailed,
					Time:  time.Now(),
					Error: &agent.ErrMeta{Code: "engine.runtime_panic", Message: fmt.Sprint(recovered)},
				})
			}
			// run.waiting ends this dispatch attempt without ending the originator
			// task. With a task-event subscription the session remains open for the
			// coordinator-started continuation; otherwise this attempt is fenced.
			session.executionReturned()
		}()

		execute(runCtx, session.publish)
	}()

	return true, nil
}

// Subscribe atomically replays events after afterSeq and attaches a live
// observer, preventing a gap between replay and live delivery. If afterSeq is
// older than the retained window, a stream.reset event is delivered instead;
// the client should reload durable run/messages state and continue from there.
func (r *ExecutionRegistry) Subscribe(runID string, afterSeq int64) (*ExecutionSubscription, bool) {
	if r == nil {
		return nil, false
	}
	r.mu.Lock()
	session, ok := r.entries[runID]
	r.mu.Unlock()
	if !ok {
		return nil, false
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	replay := make([]agent.StreamEvent, 0, len(session.events))
	if len(session.events) > 0 {
		earliest := session.events[0].StreamSeq
		latest := session.events[len(session.events)-1].StreamSeq
		if afterSeq < earliest-1 || afterSeq > latest {
			replay = append(replay, agent.StreamEvent{
				RunID:             runID,
				Type:              agent.EventStreamReset,
				Time:              time.Now(),
				StreamID:          fmt.Sprintf("%s:%d", runID, latest),
				StreamSeq:         latest,
				DeliveryReplayed:  true,
				EarliestStreamSeq: earliest,
				LatestStreamSeq:   latest,
			})
		} else {
			for _, event := range session.events {
				if event.StreamSeq <= afterSeq {
					continue
				}
				event.DeliveryReplayed = true
				replay = append(replay, event)
			}
		}
	} else if afterSeq > 0 {
		replay = append(replay, agent.StreamEvent{
			RunID:             runID,
			Type:              agent.EventStreamReset,
			Time:              time.Now(),
			StreamID:          runID + ":0",
			StreamSeq:         0,
			DeliveryReplayed:  true,
			EarliestStreamSeq: 1,
		})
	}

	capacity := executionSubscriberBuffer + len(replay)
	ch := make(chan agent.StreamEvent, capacity)
	for _, event := range replay {
		ch <- event
	}

	subscription := &ExecutionSubscription{Events: ch}
	if session.finished {
		close(ch)
		subscription.close = func() {}
		return subscription, true
	}

	session.nextSubID++
	subscriberID := session.nextSubID
	session.subscribers[subscriberID] = ch
	subscription.close = func() {
		session.mu.Lock()
		if current, exists := session.subscribers[subscriberID]; exists {
			delete(session.subscribers, subscriberID)
			close(current)
		}
		session.mu.Unlock()
	}
	return subscription, true
}

// LatestStreamSequence returns the current delivery checkpoint. Resume uses
// this before replacing a completed session so its POST observer only receives
// the new attempt while reconnect observers can still replay across attempts.
func (r *ExecutionRegistry) LatestStreamSequence(runID string) int64 {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	session, ok := r.entries[runID]
	r.mu.Unlock()
	if !ok {
		return 0
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if len(session.events) == 0 {
		return 0
	}
	return session.events[len(session.events)-1].StreamSeq
}

func (r *ExecutionRegistry) Cancel(runID string) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	session, ok := r.entries[runID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	session.cancel()
	return true
}

func (r *ExecutionRegistry) CancelAndWait(ctx context.Context, runID string) (bool, bool) {
	if r == nil {
		return false, false
	}
	r.mu.Lock()
	session, ok := r.entries[runID]
	r.mu.Unlock()
	if !ok {
		return false, false
	}
	session.cancel()
	select {
	case <-session.done:
		return true, true
	case <-ctx.Done():
		return true, false
	}
}

func (s *executionSession) publish(event agent.StreamEvent) {
	s.mu.Lock()
	if s.finished {
		s.mu.Unlock()
		return
	}

	if event.RunID == "" {
		event.RunID = s.runID
	}
	if event.OriginatorRunID == "" {
		event.OriginatorRunID = s.runID
	}
	event.StreamSeq = s.nextSeq
	event.StreamID = fmt.Sprintf("%s:%d", s.runID, s.nextSeq)
	event.DeliveryReplayed = false
	if event.Time.IsZero() {
		event.Time = time.Now()
	}
	s.nextSeq++

	if len(s.events) == executionEventBufferSize {
		copy(s.events, s.events[1:])
		s.events[len(s.events)-1] = event
	} else {
		s.events = append(s.events, event)
	}

	rootSource := event.RunID == s.runID
	if rootSource && event.Type == agent.EventRunWaiting {
		s.waiting = true
	}
	terminal := rootSource && isTerminalEvent(event.Type)
	if terminal {
		s.finished = true
	}
	for id, subscriber := range s.subscribers {
		select {
		case subscriber <- event:
		default:
			// A slow observer must never apply backpressure to the run. It can
			// reconnect with Last-Event-ID and replay from the bounded buffer.
			delete(s.subscribers, id)
			close(subscriber)
		}
	}
	if terminal {
		for id, subscriber := range s.subscribers {
			delete(s.subscribers, id)
			close(subscriber)
		}
	}
	s.mu.Unlock()

	if terminal {
		if s.taskSub != nil {
			s.taskSub.Close()
		}
		s.cancel()
		s.doneOnce.Do(func() { close(s.done) })
		if s.onFinished != nil {
			s.onFinished(s)
		}
	}
}

func (s *executionSession) forwardTaskEvents() {
	defer s.finish()
	for event := range s.taskSub.Events {
		s.publish(event)
	}
}

func (s *executionSession) executionReturned() {
	s.mu.Lock()
	keepOpen := !s.finished && s.waiting && s.taskSub != nil
	s.mu.Unlock()
	if !keepOpen {
		s.finish()
	}
}

func (s *executionSession) finish() {
	s.mu.Lock()
	if s.finished {
		s.mu.Unlock()
		return
	}
	s.finished = true
	for id, subscriber := range s.subscribers {
		delete(s.subscribers, id)
		close(subscriber)
	}
	s.mu.Unlock()

	if s.taskSub != nil {
		s.taskSub.Close()
	}
	s.cancel()
	s.doneOnce.Do(func() { close(s.done) })
	if s.onFinished != nil {
		s.onFinished(s)
	}
}

func isTerminalEvent(eventType agent.EventType) bool {
	return eventType == agent.EventRunCompleted ||
		eventType == agent.EventRunFailed ||
		eventType == agent.EventRunCancelled
}
