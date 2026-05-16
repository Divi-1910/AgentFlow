package model_test

import (
	"testing"

	"backend/model"
)

func TestHashPasswordProducesNonEmptyHash(t *testing.T) {
	t.Parallel()
	u := &model.User{}
	if err := u.HashPassword("mypassword"); err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if u.Password == "" {
		t.Error("expected non-empty hash")
	}
	if u.Password == "mypassword" {
		t.Error("password should be hashed, not stored in plain text")
	}
}

func TestCheckPasswordSucceedsWithCorrectPassword(t *testing.T) {
	t.Parallel()
	u := &model.User{}
	_ = u.HashPassword("correctpassword")
	if err := u.CheckPassword("correctpassword"); err != nil {
		t.Errorf("CheckPassword with correct password: %v", err)
	}
}

func TestCheckPasswordFailsWithWrongPassword(t *testing.T) {
	t.Parallel()
	u := &model.User{}
	_ = u.HashPassword("correctpassword")
	if err := u.CheckPassword("wrongpassword"); err == nil {
		t.Error("expected error for wrong password, got nil")
	}
}

func TestHashPasswordIsDeterministicallyDifferentEachCall(t *testing.T) {
	t.Parallel()
	// bcrypt uses a random salt — same input should produce different hashes
	u1, u2 := &model.User{}, &model.User{}
	_ = u1.HashPassword("samepassword")
	_ = u2.HashPassword("samepassword")
	if u1.Password == u2.Password {
		t.Error("bcrypt should produce different hashes for the same password (random salt)")
	}
	// but both should verify correctly
	if err := u1.CheckPassword("samepassword"); err != nil {
		t.Errorf("u1.CheckPassword: %v", err)
	}
	if err := u2.CheckPassword("samepassword"); err != nil {
		t.Errorf("u2.CheckPassword: %v", err)
	}
}
