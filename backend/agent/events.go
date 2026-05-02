package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"backend/llm"
)

type EventType string

const (
	EventRunStarted     EventType = "run.started"
	EventRunCompleted   EventType = "run.completed"
	EventRunFailed      EventType = "run.failed"
	EventRunCancelled   EventType = "run.cancelled"
	EventRunPersisted   EventType = "run.persisted"
	EventRunPersistFail EventType = "run.persist_failed"
	EventRunResumed     EventType = "run.resumed"
	EventStepStarted    EventType = "step.started"
	EventStepCompleted  EventType = "step.completed"
	EventModelDelta     EventType = "model.delta"
	EventModelCompleted EventType = "model.completed"
	EventToolStarted    EventType = "tool.started"
	EventToolCompleted  EventType = "tool.completed"
	EventToolFailed     EventType = "tool.failed"
	EventStatusUpdated  EventType = "status.updated"
)

type ToolMeta struct {
	ID      string          `json:"id,omitempty"`
	Name    string          `json:"name,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Display string          `json:"display,omitempty"`
}

type ErrMeta struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type StreamEvent struct {
	ID    string    `json:"id"`
	RunID string    `json:"run_id"`
	Seq   int64     `json:"seq"`
	Type  EventType `json:"type"`
	Time  time.Time `json:"time"`

	Attempt int `json:"attempt,omitempty"`

	Step     int `json:"step,omitempty"`
	MaxSteps int `json:"max_steps,omitempty"`

	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`

	Status  string `json:"status,omitempty"`
	Delta   string `json:"delta,omitempty"`
	Content string `json:"content,omitempty"`

	DurationMs int64 `json:"duration_ms,omitempty"`

	Tool  *ToolMeta       `json:"tool,omitempty"`
	Usage *llm.TokenUsage `json:"usage,omitempty"`
	Error *ErrMeta        `json:"error,omitempty"`
}

type EventSink interface {
	Emit(e StreamEvent)
	Close()
}

type ChannelSink struct {
	ctx       context.Context
	mu        sync.Mutex
	seq       int64
	runID     string
	ch        chan<- StreamEvent
	closeOnce sync.Once
}

func NewChannelSink(ctx context.Context, runID string, ch chan<- StreamEvent) *ChannelSink {
	return &ChannelSink{
		ctx:   ctx,
		seq:   1,
		runID: runID,
		ch:    ch,
	}
}

func (s *ChannelSink) Emit(e StreamEvent) {
	s.mu.Lock()
	seq := s.seq
	s.seq++
	s.mu.Unlock()

	e.ID = fmt.Sprintf("%s-%d", s.runID, seq)
	e.RunID = s.runID
	e.Seq = seq
	e.Time = time.Now()

	// Status events are informational — drop silently if the channel is full
	// or the run is already done.
	if e.Type == EventStatusUpdated {
		select {
		case <-s.ctx.Done():
		case s.ch <- e:
		default:
		}
		return
	}

	// All other events: deliver or drop when the run context is cancelled.
	select {
	case <-s.ctx.Done():
	case s.ch <- e:
	}
}

func (s *ChannelSink) Close() {
	s.closeOnce.Do(func() {
		close(s.ch)
	})
}

type NoopSink struct{}

func (s *NoopSink) Emit(e StreamEvent) {}
func (s *NoopSink) Close()             {}
