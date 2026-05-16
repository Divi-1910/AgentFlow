package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/auth"
	"backend/middleware"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// captureHandler returns an http.HandlerFunc that records the request it received.
func captureHandler(captured **http.Request) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		*captured = r
		w.WriteHeader(http.StatusOK)
	}
}

// validToken generates a real JWT using a fixed test secret and the given ID.
// t.Setenv ensures JWT_SECRET is restored after the test.
func validToken(t *testing.T) string {
	t.Helper()
	t.Setenv("JWT_SECRET", "test-secret-for-middleware")
	id := bson.NewObjectID()
	tok, err := auth.GenerateToken(id)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	return tok
}

// ── RequireAuth ───────────────────────────────────────────────────────────────

func TestRequireAuthRejectsRequestWithNoAuthHeader(t *testing.T) {
	// Not parallel: manipulates JWT_SECRET env var
	var captured *http.Request
	h := middleware.RequireAuth(captureHandler(&captured))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	h(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
	if captured != nil {
		t.Error("inner handler should not have been called")
	}
}

func TestRequireAuthRejectsNonBearerScheme(t *testing.T) {
	var captured *http.Request
	h := middleware.RequireAuth(captureHandler(&captured))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	w := httptest.NewRecorder()
	h(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
	if captured != nil {
		t.Error("inner handler should not have been called")
	}
}

func TestRequireAuthRejectsGarbageToken(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-for-middleware")
	var captured *http.Request
	h := middleware.RequireAuth(captureHandler(&captured))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer this-is-not-a-jwt")
	w := httptest.NewRecorder()
	h(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
	if captured != nil {
		t.Error("inner handler should not have been called")
	}
}

func TestRequireAuthRejectsTokenSignedWithWrongKey(t *testing.T) {
	// Generate token with key A, then validate with key B.
	t.Setenv("JWT_SECRET", "key-used-to-sign")
	tok, err := auth.GenerateToken(bson.NewObjectID())
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	t.Setenv("JWT_SECRET", "different-key-used-to-validate")
	var captured *http.Request
	h := middleware.RequireAuth(captureHandler(&captured))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestRequireAuthPassesValidTokenAndInjectsUserID(t *testing.T) {
	tok := validToken(t)

	var captured *http.Request
	h := middleware.RequireAuth(captureHandler(&captured))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	if captured == nil {
		t.Fatal("inner handler was not called")
	}
	userID, ok := captured.Context().Value(middleware.UserIDKey).(string)
	if !ok || userID == "" {
		t.Error("UserIDKey not injected into context or is empty")
	}
}
