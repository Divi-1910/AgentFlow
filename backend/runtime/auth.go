package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"backend/middleware"
)

type authMode string

const (
	authModeBearer authMode = "bearer"
	authModeNone   authMode = "none"
)

type authConfig struct {
	mode      authMode
	tokenHash [sha256.Size]byte
}

func loadAuthConfig(getenv func(string) string) (authConfig, error) {
	mode := strings.ToLower(strings.TrimSpace(getenv("RUNTIME_AUTH_MODE")))
	if mode == "" {
		mode = string(authModeBearer)
	}
	switch authMode(mode) {
	case authModeNone:
		return authConfig{mode: authModeNone}, nil
	case authModeBearer:
		token := getenv("RUNTIME_API_TOKEN")
		if token == "" {
			return authConfig{}, fmt.Errorf("runtime auth: RUNTIME_API_TOKEN is required when RUNTIME_AUTH_MODE=bearer")
		}
		if strings.TrimSpace(token) != token {
			return authConfig{}, fmt.Errorf("runtime auth: RUNTIME_API_TOKEN must not have leading or trailing whitespace")
		}
		return authConfig{mode: authModeBearer, tokenHash: sha256.Sum256([]byte(token))}, nil
	default:
		return authConfig{}, fmt.Errorf("runtime auth: unsupported RUNTIME_AUTH_MODE %q", mode)
	}
}

func (a authConfig) middleware(userID string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.mode == authModeBearer {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") || len(header) == len("Bearer ") {
				middleware.WriteJSONError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			provided := sha256.Sum256([]byte(strings.TrimPrefix(header, "Bearer ")))
			if subtle.ConstantTimeCompare(provided[:], a.tokenHash[:]) != 1 {
				middleware.WriteJSONError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
		}
		ctx := context.WithValue(r.Context(), middleware.UserIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func logAuthMode(logger *slog.Logger, cfg authConfig) {
	if cfg.mode == authModeNone {
		logger.Warn("runtime API authentication disabled; ingress must enforce access", "auth_mode", cfg.mode)
		return
	}
	logger.Info("runtime API authentication enabled", "auth_mode", cfg.mode)
}
