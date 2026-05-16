package handlers_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"backend/handlers"
	"backend/middleware"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ── fakeUserStore ─────────────────────────────────────────────────────────────

type fakeUserStore struct {
	findByEmailFn func(context.Context, string) (*model.User, error)
	insertFn      func(context.Context, *model.User) (bool, error)
	findByIDFn    func(context.Context, string) (*model.User, error)
}

func (f *fakeUserStore) FindByEmail(ctx context.Context, email string) (*model.User, error) {
	if f.findByEmailFn != nil {
		return f.findByEmailFn(ctx, email)
	}
	return nil, nil // not found by default
}

func (f *fakeUserStore) Insert(ctx context.Context, user *model.User) (bool, error) {
	if f.insertFn != nil {
		return f.insertFn(ctx, user)
	}
	return true, nil
}

func (f *fakeUserStore) FindByID(ctx context.Context, id string) (*model.User, error) {
	if f.findByIDFn != nil {
		return f.findByIDFn(ctx, id)
	}
	return nil, nil // not found by default
}

// ── constructor helpers ───────────────────────────────────────────────────────

func newAuthHandler(us *fakeUserStore) *handlers.AuthHandler {
	return handlers.NewAuthHandler(us, nil) // nil → defaults to auth.GenerateToken
}

func newAuthHandlerWithToken(us *fakeUserStore, gen func(bson.ObjectID) (string, error)) *handlers.AuthHandler {
	return handlers.NewAuthHandler(us, gen)
}

// userWithHashedPassword returns a model.User with a bcrypt-hashed password.
func userWithHashedPassword(t *testing.T, password string) *model.User {
	t.Helper()
	u := &model.User{ID: bson.NewObjectID(), Email: "test@example.com"}
	if err := u.HashPassword(password); err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	return u
}

func signupJSON(email, password string) *strings.Reader {
	return strings.NewReader(`{"email":"` + email + `","password":"` + password + `","first_name":"Test"}`)
}

// ── SignUp ────────────────────────────────────────────────────────────────────

func TestSignUpRejects405ForGet(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/auth/signup", nil)
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want 405", w.Code)
	}
}

func TestSignUpReturns400OnInvalidBody(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup", strings.NewReader("not-json"))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestSignUpReturns400WhenEmailEmpty(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup",
		strings.NewReader(`{"password":"longpassword"}`))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestSignUpReturns400WhenPasswordTooShort(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup",
		signupJSON("a@b.com", "short"))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestSignUpReturns500WhenFindByEmailFails(t *testing.T) {
	t.Parallel()
	us := &fakeUserStore{
		findByEmailFn: func(_ context.Context, _ string) (*model.User, error) {
			return nil, errors.New("db unavailable")
		},
	}
	h := newAuthHandler(us)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup", signupJSON("a@b.com", "validpassword"))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestSignUpReturns409WhenUserExists(t *testing.T) {
	t.Parallel()
	us := &fakeUserStore{
		findByEmailFn: func(_ context.Context, _ string) (*model.User, error) {
			return &model.User{Email: "a@b.com"}, nil
		},
	}
	h := newAuthHandler(us)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup", signupJSON("a@b.com", "validpassword"))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("got %d, want 409", w.Code)
	}
}

func TestSignUpReturns500WhenInsertFails(t *testing.T) {
	t.Parallel()
	us := &fakeUserStore{
		insertFn: func(_ context.Context, _ *model.User) (bool, error) {
			return false, errors.New("insert failed")
		},
	}
	h := newAuthHandler(us)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup", signupJSON("a@b.com", "validpassword"))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestSignUpReturns201OnSuccess(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{}) // defaults: not found, insert ok
	r := httptest.NewRequest(http.MethodPost, "/api/auth/signup", signupJSON("a@b.com", "validpassword"))
	w := httptest.NewRecorder()
	h.SignUp(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("got %d, want 201 — body: %s", w.Code, w.Body)
	}
}

// ── Login ─────────────────────────────────────────────────────────────────────

func TestLoginRejects405ForGet(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/auth/login", nil)
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want 405", w.Code)
	}
}

func TestLoginReturns400OnInvalidBody(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader("not-json"))
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestLoginReturns401WhenUserNotFound(t *testing.T) {
	t.Parallel()
	// default fakeUserStore.FindByEmail returns nil, nil
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"email":"nobody@b.com","password":"pass"}`))
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestLoginReturns401WhenPasswordWrong(t *testing.T) {
	t.Parallel()
	stored := userWithHashedPassword(t, "correctpassword")
	us := &fakeUserStore{
		findByEmailFn: func(_ context.Context, _ string) (*model.User, error) {
			return stored, nil
		},
	}
	h := newAuthHandler(us)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"wrongpassword"}`))
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
}

func TestLoginReturns500WhenTokenGenerationFails(t *testing.T) {
	t.Parallel()
	stored := userWithHashedPassword(t, "correctpassword")
	us := &fakeUserStore{
		findByEmailFn: func(_ context.Context, _ string) (*model.User, error) {
			return stored, nil
		},
	}
	failGen := func(_ bson.ObjectID) (string, error) {
		return "", errors.New("signing key unavailable")
	}
	h := newAuthHandlerWithToken(us, failGen)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"correctpassword"}`))
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestLoginReturns200WithTokenOnSuccess(t *testing.T) {
	t.Parallel()
	stored := userWithHashedPassword(t, "correctpassword")
	us := &fakeUserStore{
		findByEmailFn: func(_ context.Context, _ string) (*model.User, error) {
			return stored, nil
		},
	}
	fakeGen := func(_ bson.ObjectID) (string, error) {
		return "signed-jwt-token", nil
	}
	h := newAuthHandlerWithToken(us, fakeGen)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"correctpassword"}`))
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["token"] != "signed-jwt-token" {
		t.Errorf("token: got %v, want %q", resp["token"], "signed-jwt-token")
	}
}

// ── Me ────────────────────────────────────────────────────────────────────────

func TestMeRejects405ForPost(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/me", nil)
	w := httptest.NewRecorder()
	h.Me(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want 405", w.Code)
	}
}

func TestMeReturns500WhenNoUserInContext(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	// no withUser — context has no UserIDKey
	w := httptest.NewRecorder()
	h.Me(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500", w.Code)
	}
}

func TestMeReturns400WhenUserIDIsNotValidObjectID(t *testing.T) {
	t.Parallel()
	h := newAuthHandler(&fakeUserStore{})
	r := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	// inject a non-ObjectID string
	r = r.WithContext(context.WithValue(r.Context(), middleware.UserIDKey, "not-an-objectid"))
	w := httptest.NewRecorder()
	h.Me(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400", w.Code)
	}
}

func TestMeReturns404WhenUserNotFound(t *testing.T) {
	t.Parallel()
	// default FindByID returns nil, nil
	h := newAuthHandler(&fakeUserStore{})
	r := withUser(httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))
	w := httptest.NewRecorder()
	h.Me(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", w.Code)
	}
}

func TestMeReturns200WithUserOnSuccess(t *testing.T) {
	t.Parallel()
	us := &fakeUserStore{
		findByIDFn: func(_ context.Context, _ string) (*model.User, error) {
			return &model.User{Email: "user@example.com"}, nil
		},
	}
	h := newAuthHandler(us)
	r := withUser(httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))
	w := httptest.NewRecorder()
	h.Me(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	decodeJSON(t, w.Body.Bytes(), &resp)
	if resp["user"] == nil {
		t.Error("expected 'user' field in response")
	}
}
