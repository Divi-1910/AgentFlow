package integration_test

import (
	"net/http"
	"testing"
)

func TestSignUpCreatesUser(t *testing.T) {
	e := newTestEnv(t)
	resp := e.do(t, "POST", "/api/auth/signup", map[string]any{
		"first_name": "Alice",
		"last_name":  "Smith",
		"email":      "alice@example.com",
		"password":   "password123",
	}, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}
	var body map[string]any
	decodeBody(t, resp, &body)
	if body["status"] == nil {
		t.Fatal("expected 'status' field in response")
	}
}

func TestSignUpDuplicateEmailReturnsConflict(t *testing.T) {
	e := newTestEnv(t)
	payload := map[string]any{
		"first_name": "Bob",
		"last_name":  "Jones",
		"email":      "bob@example.com",
		"password":   "password123",
	}
	// First signup succeeds.
	resp := e.do(t, "POST", "/api/auth/signup", payload, "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("first signup: expected 201, got %d", resp.StatusCode)
	}
	// Second signup with same email → conflict.
	resp2 := e.do(t, "POST", "/api/auth/signup", payload, "")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate signup: expected 409, got %d", resp2.StatusCode)
	}
}

func TestLoginReturnsToken(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "carol@example.com", "password123")
	if token == "" {
		t.Fatal("expected non-empty JWT token")
	}
}

func TestLoginWrongPasswordReturns401(t *testing.T) {
	e := newTestEnv(t)
	// Sign up first.
	resp := e.do(t, "POST", "/api/auth/signup", map[string]any{
		"first_name": "Dave",
		"last_name":  "Lee",
		"email":      "dave@example.com",
		"password":   "correctpass123",
	}, "")
	resp.Body.Close()

	// Login with wrong password.
	resp2 := e.do(t, "POST", "/api/auth/login", map[string]any{
		"email":    "dave@example.com",
		"password": "wrongpassword",
	}, "")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp2.StatusCode)
	}
}

func TestMeReturnsUserProfile(t *testing.T) {
	e := newTestEnv(t)
	token := e.mustSignup(t, "eve@example.com", "password123")

	resp := e.do(t, "GET", "/api/auth/me", nil, token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body struct {
		User struct {
			Email string `json:"email"`
		} `json:"user"`
	}
	decodeBody(t, resp, &body)
	if body.User.Email != "eve@example.com" {
		t.Errorf("email: got %q, want %q", body.User.Email, "eve@example.com")
	}
}

func TestMeWithoutTokenReturns401(t *testing.T) {
	e := newTestEnv(t)
	resp := e.do(t, "GET", "/api/auth/me", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}
