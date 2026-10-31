// Package pagination defines the storage-neutral cursor contract used by
// client-facing collection APIs. Cursors are opaque at the HTTP boundary but
// decode into a stable (timestamp, id) or numeric position for repositories.
package pagination

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const MaxLimit = 200

var ErrInvalidCursor = errors.New("invalid pagination cursor")

type Cursor struct {
	Kind   string    `json:"k"`
	Time   time.Time `json:"t,omitempty"`
	ID     string    `json:"i,omitempty"`
	Number int       `json:"n,omitempty"`
}

type Request struct {
	Limit  int
	Cursor *Cursor
}

type Page[T any] struct {
	Items   []T
	Next    *Cursor
	HasMore bool
}

type Response[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
}

func Limit(value, fallback int) (int, error) {
	if value == 0 {
		return fallback, nil
	}
	if value < 1 || value > MaxLimit {
		return 0, fmt.Errorf("limit must be between 1 and %d", MaxLimit)
	}
	return value, nil
}

func Encode(cursor *Cursor) (string, error) {
	if cursor == nil {
		return "", nil
	}
	if strings.TrimSpace(cursor.Kind) == "" {
		return "", ErrInvalidCursor
	}
	raw, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func Decode(raw, expectedKind string) (*Cursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, ErrInvalidCursor
	}
	var cursor Cursor
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil || cursor.Kind != expectedKind {
		return nil, ErrInvalidCursor
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, ErrInvalidCursor
	}
	numeric := cursor.Number > 0 && cursor.Time.IsZero() && cursor.ID == ""
	compound := cursor.Number == 0 && !cursor.Time.IsZero() && cursor.ID != ""
	if !numeric && !compound {
		return nil, ErrInvalidCursor
	}
	return &cursor, nil
}
