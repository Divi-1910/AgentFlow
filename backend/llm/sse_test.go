package llm

import (
	"context"
	"strings"
	"testing"
)

func TestReadSSEPreservesFramingAndFinalEvent(t *testing.T) {
	input := ": keepalive\r\n" +
		"event: first\r\n" +
		"data: one\r\n" +
		"data: two\r\n\r\n" +
		"ignored: value\n" +
		"event: final\n" +
		"data: done"

	var events []sseEvent
	err := readSSE(context.Background(), strings.NewReader(input), func(event sseEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("readSSE() error = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("event count = %d, want 2", len(events))
	}
	if events[0].Name != "first" || events[0].Data != "one\ntwo" {
		t.Fatalf("first event = %#v", events[0])
	}
	if events[1].Name != "final" || events[1].Data != "done" {
		t.Fatalf("final event = %#v", events[1])
	}
}

func TestReadSSEPropagatesHandlerError(t *testing.T) {
	want := context.Canceled
	err := readSSE(context.Background(), strings.NewReader("data: x\n\n"), func(sseEvent) error {
		return want
	})
	if err != want {
		t.Fatalf("readSSE() error = %v, want %v", err, want)
	}
}
