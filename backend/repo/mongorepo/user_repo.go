package mongorepo

import (
	"context"

	"backend/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type UserRepo struct {
	col *mongo.Collection
}

func NewUserRepo(col *mongo.Collection) *UserRepo {
	return &UserRepo{col: col}
}

// FindByEmail returns the user with the given email, or (nil, nil) if not found.
func (r *UserRepo) FindByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.col.FindOne(ctx, bson.M{"email": email}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// Insert inserts the user and returns whether the write was acknowledged.
func (r *UserRepo) Insert(ctx context.Context, user *model.User) (bool, error) {
	res, err := r.col.InsertOne(ctx, user)
	if err != nil {
		return false, err
	}
	return res.Acknowledged, nil
}

// FindByID returns the user with the given hex ObjectID string, or (nil, nil) if not found.
func (r *UserRepo) FindByID(ctx context.Context, id string) (*model.User, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, err
	}
	var u model.User
	err = r.col.FindOne(ctx, bson.M{"_id": oid}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
