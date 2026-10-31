package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"backend/agent"
)

type runOutcome struct {
	res *agent.RunResult
	err error
}

type streamResult struct {
	out           runOutcome
	terminalEvent *agent.StreamEvent
}

// collectRunExecution drains the engine event channel independently of every
// HTTP observer. Non-terminal events are published immediately; the terminal
// event is held back so callers can publish persistence status before closing
// the public stream.
func collectRunExecution(
	events <-chan agent.StreamEvent,
	done <-chan runOutcome,
	publish func(agent.StreamEvent),
	logger *slog.Logger,
) streamResult {
	eventCh := events
	doneCh := done
	var terminalEvent *agent.StreamEvent
	var out runOutcome

	for eventCh != nil || doneCh != nil {
		select {
		case event, ok := <-eventCh:
			if !ok {
				eventCh = nil
				continue
			}
			if isTerminalEvent(event.Type) {
				if terminalEvent == nil {
					copy := event
					terminalEvent = &copy
				} else if logger != nil {
					logger.Warn("duplicate terminal event", "type", event.Type)
				}
				continue
			}
			publish(event)
		case out = <-doneCh:
			doneCh = nil
		}
	}

	if out.err != nil && terminalEvent == nil {
		terminalEvent = &agent.StreamEvent{
			Type:  agent.EventRunFailed,
			Time:  time.Now(),
			Error: &agent.ErrMeta{Code: "engine.runtime_error", Message: out.err.Error()},
		}
	}
	return streamResult{out: out, terminalEvent: terminalEvent}
}

func writeSSEHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
}

// serveSubscription streams one observer until it disconnects or the session
// reaches a terminal event. Returning from here only detaches the observer.
func serveSubscription(
	ctx context.Context,
	w http.ResponseWriter,
	flusher http.Flusher,
	subscription *ExecutionSubscription,
) {
	if subscription == nil {
		return
	}
	defer subscription.Close()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-subscription.Events:
			if !ok {
				return
			}
			if err := emitEvent(w, flusher, event); err != nil {
				return
			}
		}
	}
}

func emitEvent(w http.ResponseWriter, flusher http.Flusher, event agent.StreamEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal SSE event: %w", err)
	}
	streamID := event.StreamID
	if streamID == "" {
		streamID = event.ID
	}
	if streamID != "" {
		if _, err := fmt.Fprintf(w, "id: %s\n", streamID); err != nil {
			return err
		}
	}
	if event.Type != "" {
		if _, err := fmt.Fprintf(w, "event: %s\n", event.Type); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}
