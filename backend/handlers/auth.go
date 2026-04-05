package handlers

import (
	"backend/auth"
	"backend/model"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type AuthHandler struct {
	Users *mongo.Collection
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
		http.Error(w, "Invalid Request Payload", http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Password == "" || len(req.Password) < 8 {
		http.Error(w, "Email and a valid Password (min 8 chars) are required", http.StatusBadRequest)
		return
	}

	var existingUser model.User

	err := ah.Users.FindOne(context.TODO(), bson.M{
		"email": req.Email,
	}).Decode(&existingUser)

	if err == nil {
		http.Error(w, "User already exists", http.StatusConflict)
		return
	}

	user := model.User{
		FirstName: req.FirstName,
		LastName:  req.LastName,
		Email:     req.Email,
	}

	if err := user.HashPassword(req.Password); err != nil {
		http.Error(w, "Failed to hash password", http.StatusInternalServerError)
		return
	}

	user.CreatedAt = time.Now()
	user.UpdatedAt = time.Now()

	res, err := ah.Users.InsertOne(context.TODO(), user)

	if err != nil {
		http.Error(w, "Error Creating user", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)

	json.NewEncoder(w).Encode(map[string]any{
		"status": res.Acknowledged,
	})
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
		http.Error(w, "Invalid Request Payload", http.StatusBadRequest)
		return
	}

	var existingUser model.User

	err := h.Users.FindOne(context.TODO(), bson.M{
		"email": req.Email,
	}).Decode(&existingUser)

	if err != nil {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := existingUser.CheckPassword(req.Password); err != nil {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	token, err := auth.GenerateToken(existingUser.ID)
	if err != nil {
		http.Error(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(
		map[string]any{
			"token": token,
		},
	)

}
