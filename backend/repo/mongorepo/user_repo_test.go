package mongorepo_test

import (
	"context"
	"testing"
	"time"

	"backend/model"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestUserRepoInsertAndFindByEmail(t *testing.T) {
	r := mongorepo.NewUserRepo(col(t, "users"))
	ctx := context.Background()

	u := &model.User{
		ID:        bson.NewObjectID(),
		FirstName: "Alice",
		LastName:  "Smith",
		Email:     "alice@example.com",
		Password:  "hashed-pw",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	ok, err := r.Insert(ctx, u)
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if !ok {
		t.Fatal("Insert: expected acknowledged=true")
	}

	got, err := r.FindByEmail(ctx, "alice@example.com")
	if err != nil {
		t.Fatalf("FindByEmail: %v", err)
	}
	if got == nil {
		t.Fatal("FindByEmail: expected non-nil user, got nil")
	}
	if got.Email != "alice@example.com" {
		t.Errorf("Email: got %q, want %q", got.Email, "alice@example.com")
	}
	if got.FirstName != "Alice" {
		t.Errorf("FirstName: got %q, want %q", got.FirstName, "Alice")
	}
}

func TestUserRepoFindByEmailReturnsNilForMissing(t *testing.T) {
	r := mongorepo.NewUserRepo(col(t, "users"))
	ctx := context.Background()

	got, err := r.FindByEmail(ctx, "nobody@example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for missing email, got %+v", got)
	}
}

func TestUserRepoFindByIDRoundTrip(t *testing.T) {
	r := mongorepo.NewUserRepo(col(t, "users"))
	ctx := context.Background()

	u := &model.User{
		ID:        bson.NewObjectID(),
		FirstName: "Bob",
		LastName:  "Jones",
		Email:     "bob@example.com",
		Password:  "hashed-pw",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if _, err := r.Insert(ctx, u); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	got, err := r.FindByID(ctx, u.ID.Hex())
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got == nil {
		t.Fatal("FindByID: expected non-nil user, got nil")
	}
	if got.ID != u.ID {
		t.Errorf("ID: got %v, want %v", got.ID, u.ID)
	}
	if got.Email != "bob@example.com" {
		t.Errorf("Email: got %q, want %q", got.Email, "bob@example.com")
	}
}

func TestUserRepoFindByIDReturnsNilForMissing(t *testing.T) {
	r := mongorepo.NewUserRepo(col(t, "users"))
	ctx := context.Background()

	got, err := r.FindByID(ctx, "507f1f77bcf86cd799439099")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for missing ID, got %+v", got)
	}
}
