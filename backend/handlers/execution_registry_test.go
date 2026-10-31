package handlers_test

import (
	"context"
	"testing"
	"time"

	"backend/agent"
	"backend/handlers"
)

func TestExecutionSubscriptionDetachDoesNotCancelRun(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	ready := make(chan struct{})
	release := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	started, err := registry.Start("run-detach", func(ctx context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunStarted})
		close(ready)
		select {
		case <-ctx.Done():
			cancelled <- struct{}{}
			publish(agent.StreamEvent{Type: agent.EventRunCancelled})
		case <-release:
			publish(agent.StreamEvent{Type: agent.EventRunCompleted})
		}
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	<-ready
	subscription, ok := registry.Subscribe("run-detach", 0)
	if !ok {
		t.Fatal("Subscribe() did not find active execution")
	}
	subscription.Close()
	close(release)

	reconnected, ok := registry.Subscribe("run-detach", 0)
	if !ok {
		t.Fatal("reconnect did not find retained execution")
	}
	events := collectSubscription(t, reconnected)
	if len(events) == 0 || events[len(events)-1].Type != agent.EventRunCompleted {
		t.Fatalf("reconnected events = %#v, want terminal run.completed", events)
	}
	select {
	case <-cancelled:
		t.Fatal("detaching the observer cancelled the execution")
	default:
	}
}

func TestExecutionRegistryReplaysAfterStreamSequence(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	started, err := registry.Start("run-replay", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunStarted})
		publish(agent.StreamEvent{Type: agent.EventModelDelta, Delta: "hello"})
		publish(agent.StreamEvent{Type: agent.EventRunCompleted})
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	initial, ok := registry.Subscribe("run-replay", 0)
	if !ok {
		t.Fatal("Subscribe() did not find execution")
	}
	all := collectSubscription(t, initial)
	if len(all) != 3 {
		t.Fatalf("initial event count = %d, want 3", len(all))
	}

	replay, ok := registry.Subscribe("run-replay", 1)
	if !ok {
		t.Fatal("replay subscription did not find retained execution")
	}
	replayed := collectSubscription(t, replay)
	if len(replayed) != 2 {
		t.Fatalf("replayed event count = %d, want 2", len(replayed))
	}
	for _, event := range replayed {
		if event.StreamSeq <= 1 || !event.DeliveryReplayed {
			t.Fatalf("replayed event = %#v, want seq > 1 and delivery_replayed", event)
		}
	}
}

func TestExecutionRegistryResumeContinuesDeliverySequence(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	started, err := registry.Start("run-resume-sequence", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunStarted})
		publish(agent.StreamEvent{Type: agent.EventRunCompleted})
	})
	if err != nil || !started {
		t.Fatalf("first Start() = (%v, %v), want (true, nil)", started, err)
	}
	first, ok := registry.Subscribe("run-resume-sequence", 0)
	if !ok {
		t.Fatal("first subscription did not find execution")
	}
	firstEvents := collectSubscription(t, first)
	checkpoint := registry.LatestStreamSequence("run-resume-sequence")
	if checkpoint != 2 || len(firstEvents) != 2 {
		t.Fatalf("first checkpoint/events = %d/%d, want 2/2", checkpoint, len(firstEvents))
	}

	started, err = registry.Start("run-resume-sequence", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunResumed})
		publish(agent.StreamEvent{Type: agent.EventRunCompleted})
	})
	if err != nil || !started {
		t.Fatalf("resume Start() = (%v, %v), want (true, nil)", started, err)
	}
	resumed, ok := registry.Subscribe("run-resume-sequence", checkpoint)
	if !ok {
		t.Fatal("resume subscription did not find execution")
	}
	resumedEvents := collectSubscription(t, resumed)
	if len(resumedEvents) != 2 || resumedEvents[0].StreamSeq != 3 || resumedEvents[1].StreamSeq != 4 {
		t.Fatalf("resumed events = %#v, want stream sequences 3 and 4", resumedEvents)
	}
}

func TestExecutionRegistryWaitingEndsAttemptWithoutFailingRun(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	started, err := registry.Start("run-waiting", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunWaiting})
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	subscription, ok := registry.Subscribe("run-waiting", 0)
	if !ok {
		t.Fatal("waiting subscription did not find execution")
	}
	events := collectSubscription(t, subscription)
	if len(events) != 1 || events[0].Type != agent.EventRunWaiting {
		t.Fatalf("waiting events = %#v, want only run.waiting", events)
	}
	started, err = registry.Start("run-waiting", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{Type: agent.EventRunCompleted})
	})
	if err != nil || !started {
		t.Fatalf("resumed Start() = (%v, %v), want waiting attempt to be replaceable", started, err)
	}
}

func TestExecutionRegistryAggregatesChildEventsAcrossCoordinatorResume(t *testing.T) {
	hub := agent.NewTaskEventHub()
	registry := handlers.NewExecutionRegistryWithTaskEvents(context.Background(), hub)
	started, err := registry.Start("root-run", func(_ context.Context, publish func(agent.StreamEvent)) {
		publish(agent.StreamEvent{RunID: "root-run", OriginatorRunID: "root-run", Type: agent.EventRunStarted})
		publish(agent.StreamEvent{RunID: "root-run", OriginatorRunID: "root-run", Type: agent.EventRunWaiting})
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	subscription, ok := registry.Subscribe("root-run", 0)
	if !ok {
		t.Fatal("Subscribe() did not find task execution")
	}

	first := receiveSubscriptionEvent(t, subscription)
	waiting := receiveSubscriptionEvent(t, subscription)
	if first.Type != agent.EventRunStarted || waiting.Type != agent.EventRunWaiting {
		t.Fatalf("initial events = %s, %s", first.Type, waiting.Type)
	}

	hub.Publish(agent.StreamEvent{
		RunID: "child-run", OriginatorRunID: "root-run", ParentRunID: "root-run",
		AgentID: "child-agent", Type: agent.EventRunStarted,
	})
	hub.Publish(agent.StreamEvent{
		RunID: "child-run", OriginatorRunID: "root-run", ParentRunID: "root-run",
		AgentID: "child-agent", Type: agent.EventRunCompleted,
	})
	hub.Publish(agent.StreamEvent{
		RunID: "root-run", OriginatorRunID: "root-run", Type: agent.EventRunResumed, Attempt: 2,
	})
	hub.Publish(agent.StreamEvent{
		RunID: "root-run", OriginatorRunID: "root-run", Type: agent.EventRunCompleted, Attempt: 2,
	})

	events := []agent.StreamEvent{first, waiting}
	events = append(events, collectSubscription(t, subscription)...)
	if len(events) != 6 {
		t.Fatalf("event count = %d, want 6: %#v", len(events), events)
	}
	if events[3].RunID != "child-run" || events[3].Type != agent.EventRunCompleted {
		t.Fatalf("child terminal = %#v, want visible child completion", events[3])
	}
	if events[4].Type != agent.EventRunResumed || events[5].Type != agent.EventRunCompleted {
		t.Fatalf("root continuation = %#v, want resumed then completed", events[4:])
	}
	for index, event := range events {
		if event.StreamSeq != int64(index+1) {
			t.Fatalf("event[%d].StreamSeq = %d, want %d", index, event.StreamSeq, index+1)
		}
	}
}

func receiveSubscriptionEvent(t *testing.T, subscription *handlers.ExecutionSubscription) agent.StreamEvent {
	t.Helper()
	select {
	case event, ok := <-subscription.Events:
		if !ok {
			t.Fatal("subscription closed before expected event")
		}
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for stream event")
		return agent.StreamEvent{}
	}
}

func TestExecutionRegistrySlowSubscriberDoesNotBlockRun(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	ready := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	started, err := registry.Start("run-slow", func(_ context.Context, publish func(agent.StreamEvent)) {
		close(ready)
		<-release
		for i := 0; i < 300; i++ {
			publish(agent.StreamEvent{Type: agent.EventModelDelta, Delta: "x"})
		}
		publish(agent.StreamEvent{Type: agent.EventRunCompleted})
		close(finished)
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	<-ready
	// Deliberately never read from this observer. Its fixed live buffer should
	// be detached instead of applying backpressure to the execution.
	slow, ok := registry.Subscribe("run-slow", 0)
	if !ok {
		t.Fatal("Subscribe() did not find active execution")
	}
	defer slow.Close()
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("execution blocked behind a slow subscriber")
	}
}

func TestExecutionRegistryCancelAndWaitUsesRuntimeFence(t *testing.T) {
	registry := handlers.NewExecutionRegistry()
	ready := make(chan struct{})
	started, err := registry.Start("run-cancel", func(ctx context.Context, publish func(agent.StreamEvent)) {
		close(ready)
		<-ctx.Done()
		publish(agent.StreamEvent{Type: agent.EventRunCancelled})
	})
	if err != nil || !started {
		t.Fatalf("Start() = (%v, %v), want (true, nil)", started, err)
	}
	<-ready
	waitCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	found, stopped := registry.CancelAndWait(waitCtx, "run-cancel")
	if !found || !stopped {
		t.Fatalf("CancelAndWait() = (%v, %v), want (true, true)", found, stopped)
	}
}

func collectSubscription(t *testing.T, subscription *handlers.ExecutionSubscription) []agent.StreamEvent {
	t.Helper()
	defer subscription.Close()
	var events []agent.StreamEvent
	timeout := time.NewTimer(time.Second)
	defer timeout.Stop()
	for {
		select {
		case event, ok := <-subscription.Events:
			if !ok {
				return events
			}
			events = append(events, event)
		case <-timeout.C:
			t.Fatal("timed out waiting for terminal stream closure")
			return nil
		}
	}
}
