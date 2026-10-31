package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"backend/agent"
	"backend/middleware"
	"backend/pagination"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON: encode failed", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// decodeJSON decodes r.Body into v. Returns true on success.
// On failure it writes the appropriate error response and returns false:
//   - 413 Request Entity Too Large when the body exceeds the BodyLimit middleware cap
//   - 400 Bad Request for any other parse failure
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid request body")
		}
		return false
	}
	return true
}

func getUserID(r *http.Request) (string, bool) {
	id, ok := r.Context().Value(middleware.UserIDKey).(string)
	return id, ok && id != ""
}

func parseLimit(r *http.Request, def, max int) int {
	q := r.URL.Query().Get("limit")
	if q == "" {
		return def
	}
	n, err := strconv.Atoi(q)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func parsePage(w http.ResponseWriter, r *http.Request, kind string, defaultLimit int) (pagination.Request, bool) {
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > pagination.MaxLimit {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
			return pagination.Request{}, false
		}
		limit = parsed
	}
	limit, err := pagination.Limit(limit, defaultLimit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return pagination.Request{}, false
	}
	cursor, err := pagination.Decode(r.URL.Query().Get("cursor"), kind)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid cursor")
		return pagination.Request{}, false
	}
	return pagination.Request{Limit: limit, Cursor: cursor}, true
}

func pageResponse[T any](items []T, next *pagination.Cursor) (pagination.Response[T], error) {
	if items == nil {
		items = []T{}
	}
	encoded, err := pagination.Encode(next)
	if err != nil {
		return pagination.Response[T]{}, err
	}
	return pagination.Response[T]{Items: items, NextCursor: encoded}, nil
}

// RequireResourceKind keeps parallel Agent and Agent Team routes honest even
// though both resources share the internal agent.Agent execution model.
func RequireResourceKind(repo agentReader, expected agent.ResourceKind, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := getUserID(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		resource, err := repo.GetByID(r.Context(), r.PathValue("id"), userID)
		if err != nil || agent.EffectiveResourceKind(resource) != expected {
			writeError(w, http.StatusNotFound, resourceNotFoundMessage(expected))
			return
		}
		next(w, r)
	}
}

func resourceAPIBase(r *http.Request) string {
	if strings.HasPrefix(r.URL.Path, "/api/agent-teams/") {
		return "/api/agent-teams"
	}
	return "/api/agents"
}
