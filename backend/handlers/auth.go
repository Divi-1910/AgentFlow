package handlers

import (
	"context"
	"net/http"
	"time"

	"backend/auth"
	"backend/middleware"
	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// userStore is the persistence contract for AuthHandler.
type userStore interface {
	FindByEmail(ctx context.Context, email string) (*model.User, error) // nil, nil → not found
	Insert(ctx context.Context, user *model.User) (bool, error)         // bool = acknowledged
	FindByID(ctx context.Context, id string) (*model.User, error)       // nil, nil → not found
}

// tokenGenerator creates a signed JWT for the given user ID.
type tokenGenerator func(userID bson.ObjectID) (string, error)

type AuthHandler struct {
	users    userStore
	genToken tokenGenerator
}

// NewAuthHandler wires an AuthHandler. genToken defaults to auth.GenerateToken when nil.
func NewAuthHandler(users userStore, genToken tokenGenerator) *AuthHandler {
	if genToken == nil {
		genToken = auth.GenerateToken
	}
	return &AuthHandler{users: users, genToken: genToken}
}

func (ah *AuthHandler) SignUp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	logger := middleware.LoggerFromContext(r.Context())

	var req struct {
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Email     string `json:"email"`
		Password  string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.Email == "" || req.Password == "" || len(req.Password) < 8 {
		logger.Warn("signup: validation failed", "email", req.Email)
		writeError(w, http.StatusBadRequest, "email and a valid password (min 8 chars) are required")
		return
	}

	existing, err := ah.users.FindByEmail(r.Context(), req.Email)
	if err != nil {
		logger.Error("signup: db error checking email", "email", req.Email, "error", err)
		writeError(w, http.StatusInternalServerError, "error creating user")
		return
	}
	if existing != nil {
		logger.Warn("signup: conflict — user already exists", "email", req.Email)
		writeError(w, http.StatusConflict, "user already exists")
		return
	}

	user := model.User{
		FirstName: req.FirstName,
		LastName:  req.LastName,
		Email:     req.Email,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := user.HashPassword(req.Password); err != nil {
		logger.Error("signup: hash password failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	acknowledged, err := ah.users.Insert(r.Context(), &user)
	if err != nil {
		logger.Error("signup: insert failed", "email", req.Email, "error", err)
		writeError(w, http.StatusInternalServerError, "error creating user")
		return
	}

	logger.Info("signup: user created", "email", req.Email)
	writeJSON(w, http.StatusCreated, map[string]any{"status": acknowledged})
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	logger := middleware.LoggerFromContext(r.Context())

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	user, err := h.users.FindByEmail(r.Context(), req.Email)
	if err != nil {
		logger.Error("login: db error", "email", req.Email, "error", err)
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if user == nil {
		model.CompareDummy(req.Password) // equalize timing to prevent email enumeration
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	if err := user.CheckPassword(req.Password); err != nil {
		logger.Warn("login: incorrect password", "email", req.Email)
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := h.genToken(user.ID)
	if err != nil {
		logger.Error("login: token generation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	logger.Info("login: authenticated", "email", req.Email)
	writeJSON(w, http.StatusOK, map[string]any{"token": token})
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	logger := middleware.LoggerFromContext(r.Context())

	userIDStr, ok := r.Context().Value(middleware.UserIDKey).(string)
	if !ok || userIDStr == "" {
		logger.Error("me: invalid userID in context")
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if _, err := bson.ObjectIDFromHex(userIDStr); err != nil {
		logger.Warn("me: invalid objectid format", "user_id", userIDStr, "error", err)
		writeError(w, http.StatusBadRequest, "invalid user format")
		return
	}

	user, err := h.users.FindByID(r.Context(), userIDStr)
	if err != nil || user == nil {
		logger.Error("me: user not found", "user_id", userIDStr)
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	logger.Info("me: profile fetched", "email", user.Email)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}
