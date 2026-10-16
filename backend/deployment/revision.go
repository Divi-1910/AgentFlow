package deployment

import (
	"errors"
	"fmt"
	"time"
)

const MaxRevisionIdempotencyKeyBytes = 128

var (
	ErrRevisionNotFound            = errors.New("deployment revision not found")
	ErrRevisionIdempotencyKey      = errors.New("deployment revision idempotency key is invalid")
	ErrRevisionIdempotencyConflict = errors.New("deployment revision idempotency key was already used for different content")
)

type RevisionInput struct {
	UserID         string
	DeploymentID   string
	RootAgentID    string
	IdempotencyKey string
	SourceRevision int
	ConfigHash     string
	SchemaVersion  int
	BundleJSON     []byte
}

type Revision struct {
	UserID         string
	DeploymentID   string
	RootAgentID    string
	Revision       int
	IdempotencyKey string
	SourceRevision int
	ConfigHash     string
	SchemaVersion  int
	BundleJSON     []byte
	CreatedAt      time.Time
}

// ValidateRevisionIdempotencyKey accepts a small opaque ASCII token suitable
// for storage and exact comparison. It deliberately rejects whitespace and
// control bytes so values cannot become ambiguous in HTTP headers or logs.
func ValidateRevisionIdempotencyKey(key string) error {
	if len(key) == 0 || len(key) > MaxRevisionIdempotencyKeyBytes {
		return fmt.Errorf("%w: must contain 1 to %d bytes", ErrRevisionIdempotencyKey, MaxRevisionIdempotencyKeyBytes)
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7e {
			return fmt.Errorf("%w: must contain visible ASCII without whitespace", ErrRevisionIdempotencyKey)
		}
	}
	return nil
}
