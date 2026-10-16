package model

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type MCPServerDocument struct {
	ID            bson.ObjectID `bson:"_id,omitempty" json:"id"`
	ServerID      string        `bson:"server_id" json:"server_id"`
	Name          string        `bson:"name" json:"name"`
	Description   string        `bson:"description" json:"description"`
	Alias         string        `bson:"alias" json:"alias"`
	StudioURL     string        `bson:"studio_url" json:"studio_url"`
	DeploymentURL string        `bson:"deployment_url" json:"deployment_url"`
	Enabled       bool          `bson:"enabled" json:"enabled"`
	CreatedAt     time.Time     `bson:"created_at" json:"created_at"`
	UpdatedAt     time.Time     `bson:"updated_at" json:"updated_at"`
}
