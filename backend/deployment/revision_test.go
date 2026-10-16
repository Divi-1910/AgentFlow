package deployment

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateRevisionIdempotencyKey(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{name: "simple", key: "publish-2026-10-07"},
		{name: "visible ASCII punctuation", key: "client:request/42.v1"},
		{name: "maximum length", key: strings.Repeat("x", MaxRevisionIdempotencyKeyBytes)},
		{name: "empty", wantErr: true},
		{name: "space", key: "two words", wantErr: true},
		{name: "tab", key: "a\tb", wantErr: true},
		{name: "unicode", key: "request-☃", wantErr: true},
		{name: "too long", key: strings.Repeat("x", MaxRevisionIdempotencyKeyBytes+1), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRevisionIdempotencyKey(tt.key)
			if tt.wantErr && !errors.Is(err, ErrRevisionIdempotencyKey) {
				t.Fatalf("error = %v", err)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("error = %v", err)
			}
		})
	}
}
