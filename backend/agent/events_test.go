package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestChannelSinkAddsSourceIdentityAndToolArgsStayPrivate(t *testing.T) {
	ch := make(chan StreamEvent, 1)
	sink := NewChannelSinkWithSource(context.Background(), "child-run", EventSource{
		OriginatorRunID: "root-run",
		ParentRunID:     "parent-run",
		TeamID:          "team-1",
		AgentID:         "agent-2",
		AgentName:       "Researcher",
		Depth:           2,
		InvocationKind:  InvocationSyncDelegate,
		Attempt:         3,
	}, ch)
	sink.Emit(StreamEvent{
		Type: EventToolStarted,
		Tool: &ToolMeta{Name: "memory_write", Args: json.RawMessage(`{"secret":"value"}`)},
	})
	event := <-ch
	if event.RunID != "child-run" || event.OriginatorRunID != "root-run" || event.ParentRunID != "parent-run" {
		t.Fatalf("run lineage = %#v", event)
	}
	if event.AgentID != "agent-2" || event.AgentName != "Researcher" || event.TeamID != "team-1" || event.Depth != 2 || event.Attempt != 3 {
		t.Fatalf("source identity = %#v", event)
	}
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "secret") || strings.Contains(string(body), "value") || strings.Contains(string(body), `"args"`) {
		t.Fatalf("product event leaked raw tool arguments: %s", body)
	}
}

func TestToolEventMetaClassifiesProductCapabilities(t *testing.T) {
	runCtx := RunContext{MCPServerIDs: map[string]string{"weather": "mcp-open-meteo"}}
	mcp := toolEventMeta(runCtx, "call-1", "mcp__weather__forecast", nil, "", "", false)
	if mcp.Kind != ToolKindMCP || mcp.Operation != "forecast" || mcp.MCPAlias != "weather" || mcp.MCPServerID != "mcp-open-meteo" {
		t.Fatalf("MCP metadata = %#v", mcp)
	}
	memory := toolEventMeta(runCtx, "call-2", "memory_write", nil, "", "", false)
	if memory.Kind != ToolKindMemory || memory.Operation != "write" {
		t.Fatalf("memory metadata = %#v", memory)
	}
	delegate := toolEventMeta(runCtx, "call-3", "ask_researcher", nil, "", "agent-researcher", true)
	if delegate.Kind != ToolKindDelegate || delegate.TargetAgentID != "agent-researcher" {
		t.Fatalf("delegate metadata = %#v", delegate)
	}
}

func TestChannelSinkConcurrentEmitsPreserveReceiveSeqOrder(t *testing.T) {
	t.Parallel()

	const (
		workers       = 32
		eventsPerWork = 16
		totalEvents   = workers * eventsPerWork
	)

	ch := make(chan StreamEvent, totalEvents)
	sink := NewChannelSink(context.Background(), "run-events", ch)

	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < eventsPerWork; j++ {
				sink.Emit(StreamEvent{Type: EventToolStarted})
			}
		}()
	}
	wg.Wait()
	sink.Close()

	var got []StreamEvent
	for e := range ch {
		got = append(got, e)
	}
	if len(got) != totalEvents {
		t.Fatalf("received %d events, want %d", len(got), totalEvents)
	}
	for i, e := range got {
		wantSeq := int64(i + 1)
		if e.Seq != wantSeq {
			t.Fatalf("event[%d].Seq = %d, want %d", i, e.Seq, wantSeq)
		}
	}
}

func TestChannelSinkBlockedEmitUnblocksOnCancelAndFutureEmitsReturn(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan StreamEvent, 1)
	sink := NewChannelSink(ctx, "run-blocked", ch)

	sink.Emit(StreamEvent{Type: EventRunStarted})

	blockedDone := make(chan struct{})
	go func() {
		sink.Emit(StreamEvent{Type: EventToolCompleted})
		close(blockedDone)
	}()

	select {
	case <-blockedDone:
		t.Fatal("non-status emit returned before context cancellation on a full channel")
	case <-time.After(25 * time.Millisecond):
	}

	cancel()

	select {
	case <-blockedDone:
	case <-time.After(time.Second):
		t.Fatal("blocked emit did not unblock after context cancellation")
	}

	futureDone := make(chan struct{})
	go func() {
		sink.Emit(StreamEvent{Type: EventToolFailed})
		close(futureDone)
	}()
	select {
	case <-futureDone:
	case <-time.After(time.Second):
		t.Fatal("future emit deadlocked after cancelled blocked emit")
	}
}
