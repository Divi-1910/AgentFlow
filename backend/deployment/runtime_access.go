package deployment

import "errors"

var (
	ErrRuntimeNotReady          = errors.New("deployment runtime is not ready")
	ErrRuntimeAccessUnavailable = errors.New("deployment runtime access is unavailable")
)

// RuntimeAccess is an internal, short-lived view used by the backend proxy.
// It must never be serialized into a public API response or persisted.
type RuntimeAccess struct {
	BaseURL     string
	BearerToken string
}
