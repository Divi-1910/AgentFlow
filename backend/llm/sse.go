package llm

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"time"
)

const maxSSEEventBytes = 5 << 20 // 5 MiB; large enough for fragmented tool arguments.

type sseEvent struct {
	Name string
	Data string
}

// readSSE implements the subset of the SSE framing specification needed by the
// provider adapters. It preserves multi-line data payloads, ignores comments
// and unknown fields, accepts a final event without a trailing blank line, and
// bounds both individual lines and assembled events.
func readSSE(ctx context.Context, body io.Reader, handle func(sseEvent) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), maxSSEEventBytes)

	var (
		name    string
		data    strings.Builder
		hasData bool
	)

	dispatch := func() error {
		if !hasData {
			name = ""
			return nil
		}
		event := sseEvent{Name: name, Data: data.String()}
		name = ""
		data.Reset()
		hasData = false
		return handle(event)
	}

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}

		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}

		field, value, found := strings.Cut(line, ":")
		if !found {
			field = line
			value = ""
		} else if strings.HasPrefix(value, " ") {
			value = value[1:]
		}

		switch field {
		case "event":
			name = value
		case "data":
			additional := len(value)
			if hasData {
				additional++
			}
			if data.Len()+additional > maxSSEEventBytes {
				return fmt.Errorf("SSE event exceeds %d bytes", maxSSEEventBytes)
			}
			if hasData {
				data.WriteByte('\n')
			}
			data.WriteString(value)
			hasData = true
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read SSE stream: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return dispatch()
}

func waitForRetry(ctx context.Context, attempt int) error {
	if attempt <= 0 {
		return nil
	}
	backoff := time.Second << (attempt - 1)
	timer := time.NewTimer(backoff)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
