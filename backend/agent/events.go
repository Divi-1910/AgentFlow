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
	EventRunAccepted    EventType = "run.accepted"
	EventRunStarted     EventType = "run.started"
	EventRunCompleted   EventType = "run.completed"
	EventRunFailed      EventType = "run.failed"
	EventRunCancelled   EventType = "run.cancelled"
	EventRunPersisted   EventType = "run.persisted"
	EventRunPersistFail EventType = "run.persist_failed"
	EventRunResumed     EventType = "run.resumed"
	EventRunWaiting     EventType = "run.waiting"
	EventStepStarted    EventType = "step.started"
	EventStepCompleted  EventType = "step.completed"
	EventModelDelta     EventType = "model.delta"
	EventModelCompleted EventType = "model.completed"
	EventToolStarted    EventType = "tool.started"
	EventToolCompleted  EventType = "tool.completed"
	EventToolFailed     EventType = "tool.failed"
	EventStatusUpdated  EventType = "status.updated"
	EventJobDispatched  EventType = "job.dispatched"
	EventJobStarted     EventType = "job.started"
	EventJobCompleted   EventType = "job.completed"
	EventJobFailed      EventType = "job.failed"
	EventMCPUnavailable EventType = "mcp.unavailable"
	EventStreamReset    EventType = "stream.reset"
)

type ToolKind string

const (
	ToolKindRegular    ToolKind = "regular"
	ToolKindDelegate   ToolKind = "delegate"
	ToolKindAsync      ToolKind = "async"
	ToolKindMemory     ToolKind = "memory"
	ToolKindScratchpad ToolKind = "scratchpad"
	ToolKindMCP        ToolKind = "mcp"
)

type ToolMeta struct {
	ID            string            `json:"id,omitempty"`
	Name          string            `json:"name,omitempty"`
	Kind          ToolKind          `json:"kind,omitempty"`
	Operation     string            `json:"operation,omitempty"`
	Display       string            `json:"display,omitempty"`
	TargetAgentID string            `json:"target_agent_id,omitempty"`
	MCPServerID   string            `json:"mcp_server_id,omitempty"`
	MCPAlias      string            `json:"mcp_alias,omitempty"`
	Presentation  *ToolPresentation `json:"presentation,omitempty"`

	// Args is retained for internal execution diagnostics and tests, but is
	// deliberately excluded from the product event projection. Tool arguments
	// can contain prompts, credentials, or arbitrary payloads. Presentation is
	// the curated, bounded projection that the product timeline may display.
	Args json.RawMessage `json:"-"`
}

// ToolPresentation is the bounded, user-facing projection of one tool call.
// It deliberately contains display-safe fields rather than the raw argument
// payload. The same projection is emitted live and persisted with the tool
// message so a conversation can be reconstructed after the SSE buffer expires.
type ToolPresentation struct {
	RunningLabel   string                  `bson:"running_label,omitempty" json:"running_label,omitempty"`
	CompletedLabel string                  `bson:"completed_label,omitempty" json:"completed_label,omitempty"`
	FailedLabel    string                  `bson:"failed_label,omitempty" json:"failed_label,omitempty"`
	Summary        string                  `bson:"summary,omitempty" json:"summary,omitempty"`
	Input          []ToolPresentationField `bson:"input,omitempty" json:"input,omitempty"`
	Output         []ToolPresentationField `bson:"output,omitempty" json:"output,omitempty"`
}

type ToolPresentationField struct {
	Label  string `bson:"label" json:"label"`
	Value  string `bson:"value" json:"value"`
	Format string `bson:"format,omitempty" json:"format,omitempty"`
}

type ErrMeta struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type JobMeta struct {
	ID            string `json:"id,omitempty"`
	Status        string `json:"status,omitempty"`
	Mode          string `json:"mode,omitempty"`
	DelegateTool  string `json:"delegate_tool,omitempty"`
	TargetAgentID string `json:"target_agent_id,omitempty"`
}

type MCPMeta struct {
	Unavailable []MCPServerMeta `json:"unavailable,omitempty"`
}

type MCPServerMeta struct {
	ServerID string `json:"server_id,omitempty"`
	Alias    string `json:"alias"`
}

type StreamEvent struct {
	ID    string    `json:"id"`
	RunID string    `json:"run_id"`
	Seq   int64     `json:"seq"`
	Type  EventType `json:"type"`
	Time  time.Time `json:"time"`

	// RunID identifies the runtime source that produced the event. The
	// remaining source fields locate that run inside the complete originator
	// task tree. Delivery aggregation must never overwrite these fields.
	OriginatorRunID string `json:"originator_run_id,omitempty"`
	ParentRunID     string `json:"parent_run_id,omitempty"`
	TeamID          string `json:"team_id,omitempty"`
	AgentID         string `json:"agent_id,omitempty"`
	AgentName       string `json:"agent_name,omitempty"`
	Depth           int    `json:"depth,omitempty"`
	InvocationKind  string `json:"invocation_kind,omitempty"`

	// ID and Seq identify the event produced by the execution engine. StreamID
	// and StreamSeq identify its position in the reconnectable delivery stream.
	// Keeping them separate prevents delivery replay from changing engine event
	// identity while events from multiple runs share one originator stream.
	StreamID          string `json:"stream_id,omitempty"`
	StreamSeq         int64  `json:"stream_seq"`
	DeliveryReplayed  bool   `json:"delivery_replayed,omitempty"`
	EarliestStreamSeq int64  `json:"earliest_stream_seq,omitempty"`
	LatestStreamSeq   int64  `json:"latest_stream_seq,omitempty"`

	Attempt  int  `json:"attempt,omitempty"`
	Replayed bool `json:"replayed,omitempty"`

	Step     int `json:"step,omitempty"`
	MaxSteps int `json:"max_steps,omitempty"`

	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`

	Status  string `json:"status,omitempty"`
	Delta   string `json:"delta,omitempty"`
	Content string `json:"content,omitempty"`

	DurationMs int64 `json:"duration_ms,omitempty"`

	Tool  *ToolMeta       `json:"tool,omitempty"`
	Job   *JobMeta        `json:"job,omitempty"`
	MCP   *MCPMeta        `json:"mcp,omitempty"`
	Usage *llm.TokenUsage `json:"usage,omitempty"`
	Error *ErrMeta        `json:"error,omitempty"`
}

type EventSink interface {
	// Emit may be called concurrently. Implementations must be concurrency-safe.
	// Close is called only after all emits for the run have returned.
	Emit(e StreamEvent)
	Close()
}

type ChannelSink struct {
	ctx       context.Context
	mu        sync.Mutex
	seq       int64
	runID     string
	source    EventSource
	ch        chan<- StreamEvent
	closeOnce sync.Once
}

// EventSource is the immutable identity attached to every event emitted by
// one runtime invocation. RunID/Seq remain source-local while StreamID and
// StreamSeq are assigned later by the originator delivery stream.
type EventSource struct {
	OriginatorRunID string
	ParentRunID     string
	TeamID          string
	AgentID         string
	AgentName       string
	Depth           int
	InvocationKind  string
	Attempt         int
}

func NewChannelSink(ctx context.Context, runID string, ch chan<- StreamEvent) *ChannelSink {
	return NewChannelSinkWithSource(ctx, runID, EventSource{}, ch)
}

func NewChannelSinkWithSource(ctx context.Context, runID string, source EventSource, ch chan<- StreamEvent) *ChannelSink {
	if source.OriginatorRunID == "" {
		source.OriginatorRunID = runID
	}
	return &ChannelSink{
		ctx:    ctx,
		seq:    1,
		runID:  runID,
		source: source,
		ch:     ch,
	}
}

func (s *ChannelSink) Emit(e StreamEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()

	seq := s.seq
	s.seq++

	e.ID = fmt.Sprintf("%s-%d", s.runID, seq)
	e.RunID = s.runID
	e.Seq = seq
	e.Time = time.Now()
	e.OriginatorRunID = s.source.OriginatorRunID
	e.ParentRunID = s.source.ParentRunID
	e.TeamID = s.source.TeamID
	e.AgentID = s.source.AgentID
	e.AgentName = s.source.AgentName
	e.Depth = s.source.Depth
	e.InvocationKind = s.source.InvocationKind
	if e.Attempt == 0 {
		e.Attempt = s.source.Attempt
	}

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
