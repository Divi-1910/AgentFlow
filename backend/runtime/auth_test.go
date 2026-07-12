package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/middleware"
)

func TestLoadAuthConfig(t *testing.T) {
	tests := []struct {
		name  string
		env   map[string]string
		mode  authMode
		error bool
	}{
		{name: "default bearer", env: map[string]string{"RUNTIME_API_TOKEN": "secret"}, mode: authModeBearer},
		{name: "explicit none", env: map[string]string{"RUNTIME_AUTH_MODE": "none"}, mode: authModeNone},
		{name: "missing token", env: map[string]string{}, error: true},
		{name: "whitespace token", env: map[string]string{"RUNTIME_API_TOKEN": " secret"}, error: true},
		{name: "invalid mode", env: map[string]string{"RUNTIME_AUTH_MODE": "optional"}, error: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := loadAuthConfig(func(key string) string { return tc.env[key] })
			if (err != nil) != tc.error {
				t.Fatalf("loadAuthConfig error = %v", err)
			}
			if err == nil && cfg.mode != tc.mode {
				t.Fatalf("mode = %q, want %q", cfg.mode, tc.mode)
			}
		})
	}
}

func TestAuthMiddleware(t *testing.T) {
	cfg, err := loadAuthConfig(func(key string) string {
		if key == "RUNTIME_API_TOKEN" {
			return "secret"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, _ := r.Context().Value(middleware.UserIDKey).(string); got != "runtime_user" {
			t.Fatalf("user id = %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	for _, tc := range []struct {
		header string
		want   int
	}{{"", 401}, {"Bearer wrong", 401}, {"Bearer secret", 204}} {
		req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
		req.Header.Set("Authorization", tc.header)
		res := httptest.NewRecorder()
		cfg.middleware("runtime_user", next).ServeHTTP(res, req)
		if res.Code != tc.want {
			t.Fatalf("header %q status = %d, want %d", tc.header, res.Code, tc.want)
		}
	}
}
