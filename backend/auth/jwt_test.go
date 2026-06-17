package auth_test

import (
	"testing"

	"backend/auth"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// All tests in this file manipulate JWT_SECRET via t.Setenv.
// Do not call t.Parallel() — sequential keeps key-swapping tests deterministic.

func TestGenerateTokenProducesTokenValidatableWithSameKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-signing-key")
	id := bson.NewObjectID()

	tok, err := auth.GenerateToken(id)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if tok == "" {
		t.Fatal("expected non-empty token")
	}

	claims, err := auth.ValidateToken(tok)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.UserID != id.Hex() {
		t.Errorf("UserID: got %q, want %q", claims.UserID, id.Hex())
	}
}

func TestValidateTokenRejectsGarbageString(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-signing-key")

	_, err := auth.ValidateToken("this-is-not-a-jwt")
	if err == nil {
		t.Error("expected error for garbage token, got nil")
	}
}

func TestValidateTokenRejectsTokenSignedWithDifferentKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "signing-key")
	tok, err := auth.GenerateToken(bson.NewObjectID())
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	t.Setenv("JWT_SECRET", "different-validation-key")
	_, err = auth.ValidateToken(tok)
	if err == nil {
		t.Error("expected signature mismatch error, got nil")
	}
}

func TestValidateTokenRejectsMalformedJWT(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-signing-key")

	malformed := []string{
		"",
		"only.two",
		"a.b.c.d.e",                // too many segments
		"eyJhbGciOiJub25lIn0.e30.", // alg=none (should be rejected by HMAC check)
	}
	for _, tok := range malformed {
		_, err := auth.ValidateToken(tok)
		if err == nil {
			t.Errorf("token %q: expected error, got nil", tok)
		}
	}
}

func TestGenerateTokenEmbedsDifferentIDsInDifferentTokens(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-signing-key")

	id1 := bson.NewObjectID()
	id2 := bson.NewObjectID()

	tok1, _ := auth.GenerateToken(id1)
	tok2, _ := auth.GenerateToken(id2)

	if tok1 == tok2 {
		t.Error("tokens for different IDs should differ")
	}

	c1, _ := auth.ValidateToken(tok1)
	c2, _ := auth.ValidateToken(tok2)
	if c1.UserID == c2.UserID {
		t.Error("claims UserID should differ between tokens")
	}
}
