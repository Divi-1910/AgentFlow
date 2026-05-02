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
	out                runOutcome
	terminalEvent      *agent.StreamEvent
	clientDisconnected bool
}

func streamLoop(
	ctx context.Context,
	cancel context.CancelFunc,
	w http.ResponseWriter,
	flusher http.Flusher,
	events <-chan agent.StreamEvent,
	done <-chan runOutcome,
	logger *slog.Logger,
) streamResult {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	var terminalEvent *agent.StreamEvent
	clientDisconnected := false

loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ticker.C:
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				clientDisconnected = true
				cancel()
				break loop
			}
			flusher.Flush()
		case e, ok := <-events:
			if !ok {
				break loop
			}
			if e.Type == agent.EventRunCompleted || e.Type == agent.EventRunFailed || e.Type == agent.EventRunCancelled {
				if terminalEvent == nil {
					terminalEvent = &e
				} else {
					logger.Warn("duplicate terminal event", "type", e.Type)
				}
				continue
			}
			data, err := json.Marshal(e)
			if err != nil {
				logger.Warn("failed to marshal stream event", "type", e.Type, "error", err)
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				clientDisconnected = true
				cancel()
				break loop
			}
			flusher.Flush()
		}
	}

	out := <-done

draining:
	for {
		select {
		case e, ok := <-events:
			if !ok {
				break draining
			}
			if e.Type == agent.EventRunCompleted || e.Type == agent.EventRunFailed || e.Type == agent.EventRunCancelled {
				if terminalEvent == nil {
					terminalEvent = &e
				}
			}
		default:
			break draining
		}
	}

	if out.err != nil && terminalEvent == nil {
		terminalEvent = &agent.StreamEvent{
			Type:  agent.EventRunFailed,
			Time:  time.Now(),
			Error: &agent.ErrMeta{Code: "engine.runtime_error", Message: out.err.Error()},
		}
	}

	return streamResult{
		out:                out,
		terminalEvent:      terminalEvent,
		clientDisconnected: clientDisconnected,
	}
}

func emitEvent(w http.ResponseWriter, flusher http.Flusher, e agent.StreamEvent) {
	data, _ := json.Marshal(e)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()
}
