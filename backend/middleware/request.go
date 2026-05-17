package middleware

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

type requestIDKey struct{}

const RequestIDHeader = "X-Request-ID"

// RequestID generates a unique ID for every inbound request, injects it into
// the context, and echoes it back in the X-Request-ID response header.
// If the caller already sent an X-Request-ID header, that value is reused so
// upstream proxies / tests can correlate requests end-to-end.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set(RequestIDHeader, id)
		ctx := context.WithValue(r.Context(), requestIDKey{}, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetRequestID returns the request ID stored in ctx by RequestID middleware,
// or "" if none is present.
func GetRequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// LoggerFromContext returns slog.Default augmented with the request_id field
// when one is present in ctx. Handlers and middleware call this once per
// request instead of calling slog directly, so every log line is correlated.
func LoggerFromContext(ctx context.Context) *slog.Logger {
	if id := GetRequestID(ctx); id != "" {
		return slog.With("request_id", id)
	}
	return slog.Default()
}

// BodyLimit wraps every request body with http.MaxBytesReader.
// Reads beyond n bytes cause json.Decoder (and any other reader) to return
// *http.MaxBytesError, which handlers can detect to return 413 instead of 400.
func BodyLimit(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, n)
			next.ServeHTTP(w, r)
		})
	}
}

// WriteJSONError writes a JSON {"error": msg} response with the given status.
// Intended for use inside middleware that cannot import the handlers package.
func WriteJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
