package dispatcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"backend/agent"
	"backend/bus"
)

type BusDispatcher struct {
	Bus            bus.MessageBus
	Pools          *PoolManager
	Preparer       *RunPreparer
	RequestTimeout time.Duration
}

func (d *BusDispatcher) Dispatch(ctx context.Context, req DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
	if d.Bus == nil || d.Pools == nil {
		close(events)
		return nil, fmt.Errorf("dispatcher: bus dispatcher is not configured")
	}
	payload := payloadFromRequest(req)
	if payload.RunID == "" {
		close(events)
		return nil, fmt.Errorf("dispatcher: empty run id")
	}
	if err := d.Pools.Ensure(ctx, payload.AgentID); err != nil {
		close(events)
		return nil, err
	}

	// Events are keyed by this run's RunID; cancel by the originator (shared
	// across the whole tree). For a top-level run they're equal.
	eventsSub, err := d.Bus.Subscribe(ctx, eventsTopic(payload.RunID))
	if err != nil {
		close(events)
		return nil, err
	}

	forwardCtx, stopForwarder := context.WithCancel(ctx)
	defer stopForwarder()
	forwarderDone := make(chan struct{})
	go d.forwardEvents(forwardCtx, eventsSub, events, forwarderDone)

	cancelWatcherDone := make(chan struct{})
	go d.publishCancelOnContextDone(ctx, payload.OriginatorRunID, cancelWatcherDone)

	body, err := json.Marshal(payload)
	if err != nil {
		stopForwarder()
		_ = eventsSub.Unsubscribe()
		<-forwarderDone
		close(cancelWatcherDone)
		return nil, err
	}

	reply, reqErr := d.Bus.Request(ctx, dispatchTopic(payload.AgentID), bus.Message{Body: body}, d.RequestTimeout)
	if reqErr != nil {
		d.cancelTask(payload.OriginatorRunID)
		stopForwarder()
		_ = eventsSub.Unsubscribe()
		<-forwarderDone
		close(cancelWatcherDone)
		return nil, reqErr
	}

	var dispatchReply DispatchReply
	if err := json.Unmarshal(reply.Body, &dispatchReply); err != nil {
		stopForwarder()
		_ = eventsSub.Unsubscribe()
		<-forwarderDone
		close(cancelWatcherDone)
		return nil, err
	}

	if dispatchReply.Error != "" {
		stopForwarder()
		_ = eventsSub.Unsubscribe()
		<-forwarderDone
		close(cancelWatcherDone)
		return runResultFromWire(dispatchReply.Result), errors.New(dispatchReply.Error)
	}

	select {
	case <-forwarderDone:
	case <-ctx.Done():
		d.cancelTask(payload.OriginatorRunID)
		stopForwarder()
		_ = eventsSub.Unsubscribe()
		<-forwarderDone
		close(cancelWatcherDone)
		return nil, ctx.Err()
	case <-time.After(5 * time.Second):
		stopForwarder()
		_ = eventsSub.Unsubscribe()
		<-forwarderDone
		close(cancelWatcherDone)
		return nil, fmt.Errorf("dispatcher: timed out draining stream events")
	}
	close(cancelWatcherDone)
	return runResultFromWire(dispatchReply.Result), nil
}

func (d *BusDispatcher) EstimateSystemPromptTokens(ctx context.Context, req EstimateRequest) int {
	if d.Preparer == nil {
		return 0
	}
	return d.Preparer.EstimateSystemPromptTokens(ctx, req)
}

func (d *BusDispatcher) forwardEvents(ctx context.Context, sub bus.Subscription, events chan<- agent.StreamEvent, done chan<- struct{}) {
	defer close(done)
	defer close(events)

	for {
		select {
		case msg := <-sub.Messages():
			var event agent.StreamEvent
			if err := json.Unmarshal(msg.Body, &event); err != nil {
				continue
			}
			select {
			case events <- event:
			case <-ctx.Done():
				return
			case <-sub.Done():
				return
			}
			if isStreamEndEvent(event.Type) {
				return
			}
		case <-sub.Done():
			return
		case <-ctx.Done():
			return
		}
	}
}

func (d *BusDispatcher) publishCancelOnContextDone(ctx context.Context, originatorRunID string, done <-chan struct{}) {
	select {
	case <-ctx.Done():
		d.cancelTask(originatorRunID)
	case <-done:
	}
}

// cancelTask marks the originator cancelled in the registry (closing the
// dispatch→subscribe race) and publishes the shared cancel topic so every
// live worker in the tree unwinds.
func (d *BusDispatcher) cancelTask(originatorRunID string) {
	if d.Pools != nil {
		d.Pools.CancelTask(originatorRunID)
	}
	_ = d.Bus.Publish(context.Background(), cancelTopic(originatorRunID), bus.Message{})
}

func isTerminalEvent(eventType agent.EventType) bool {
	return eventType == agent.EventRunCompleted ||
		eventType == agent.EventRunFailed ||
		eventType == agent.EventRunCancelled
}

func isStreamEndEvent(eventType agent.EventType) bool {
	return isTerminalEvent(eventType) || eventType == agent.EventRunWaiting
}
