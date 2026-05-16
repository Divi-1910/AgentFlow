package handlers

import (
	"context"
	"encoding/json"
	"log"
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
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Email     string `json:"email"`
		Password  string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[SignUp] Failed decoding payload: %v", err)
		http.Error(w, "Invalid Request Payload", http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Password == "" || len(req.Password) < 8 {
		log.Printf("[SignUp] Validation failed for email: %s", req.Email)
		http.Error(w, "Email and a valid Password (min 8 chars) are required", http.StatusBadRequest)
		return
	}

	existing, err := ah.users.FindByEmail(r.Context(), req.Email)
	if err != nil {
		log.Printf("[SignUp] DB error checking email %s: %v", req.Email, err)
		http.Error(w, "Error Creating user", http.StatusInternalServerError)
		return
	}
	if existing != nil {
		log.Printf("[SignUp] Conflict: User already exists - %s", req.Email)
		http.Error(w, "User already exists", http.StatusConflict)
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
		http.Error(w, "Failed to hash password", http.StatusInternalServerError)
		return
	}

	acknowledged, err := ah.users.Insert(r.Context(), &user)
	if err != nil {
		log.Printf("[SignUp] DB error creating user %s: %v", req.Email, err)
		http.Error(w, "Error Creating user", http.StatusInternalServerError)
		return
	}

	log.Printf("[SignUp] Created user: %s", req.Email)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"status": acknowledged})
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[Login] Failed decoding payload: %v", err)
		http.Error(w, "Invalid Request Payload", http.StatusBadRequest)
		return
	}

	user, err := h.users.FindByEmail(r.Context(), req.Email)
	if err != nil {
		log.Printf("[Login] DB error for %s: %v", req.Email, err)
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}
	if user == nil {
		// Run a dummy bcrypt check to equalize timing with the password-mismatch
		// path, preventing email enumeration via response-time measurement.
		model.CompareDummy(req.Password)
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := user.CheckPassword(req.Password); err != nil {
		log.Printf("[Login] Incorrect password for: %s", req.Email)
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	token, err := h.genToken(user.ID)
	if err != nil {
		log.Printf("[Login] Token generation failed: %v", err)
		http.Error(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}

	log.Printf("[Login] Authenticated: %s", req.Email)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"token": token})
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	userIDStr, ok := r.Context().Value(middleware.UserIDKey).(string)
	if !ok || userIDStr == "" {
		log.Printf("[Me] CRITICAL: Invalid UserID injected into context")
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	if _, err := bson.ObjectIDFromHex(userIDStr); err != nil {
		log.Printf("[Me] Invalid ObjectID format: %v", err)
		http.Error(w, "Invalid user format", http.StatusBadRequest)
		return
	}

	user, err := h.users.FindByID(r.Context(), userIDStr)
	if err != nil || user == nil {
		log.Printf("[Me] User missing from DB for ID %s", userIDStr)
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}

	log.Printf("[Me] Profile for: %s", user.Email)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"user": user})
}
