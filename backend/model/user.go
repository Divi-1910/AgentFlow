package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID        bson.ObjectID `bson:"_id,omitempty" json:"id,omitempty"`
	FirstName string        `bson:"first_name" json:"first_name"`
	LastName  string        `bson:"last_name" json:"last_name"`
	Email     string        `bson:"email" json:"email"`
	Password  string        `bson:"password" json:"-"`
	CreatedAt time.Time     `bson:"created_at" json:"created_at"`
	UpdatedAt time.Time     `bson:"updated_at" json:"updated_at"`
}

// dummyHash is a bcrypt hash (cost 12) computed once at startup. It is used
// by CompareDummy to equalize login response timing when a user is not found,
// preventing email-enumeration via timing differences (~80ms bcrypt vs ~1ms).
var dummyHash = func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("dummy-sentinel-not-a-real-password"), 12)
	return h
}()

// CompareDummy runs a bcrypt comparison that always fails. Call it when
// FindByEmail returns nil to match the timing of a real password check.
func CompareDummy(password string) {
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
}

func (u *User) HashPassword(password string) error {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return err
	}

	u.Password = string(bytes)
	return nil

}

func (u *User) CheckPassword(providedPassword string) error {
	err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(providedPassword))
	if err != nil {
		return err
	}
	return nil
}
