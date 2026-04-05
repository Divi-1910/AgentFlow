package db

import (
	"context"
	"log"
	"os"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var (
	client *mongo.Client
	once   sync.Once
)

func ConnectMongoDB() *mongo.Client {
	once.Do(func() {
		mongo_url := os.Getenv("MONGO_URL")
		if mongo_url == "" {
			log.Fatalf("MONGO_URL environment variable is not set")
			log.Println("Using default mongo URL")
			mongo_url = "mongodb://localhost:27017"
		}

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		opts := options.Client().ApplyURI(mongo_url)
		cl, err := mongo.Connect(opts)

		if err != nil {
			log.Fatalf("failed to connect to mongoDB : %v", err)
		}

		if err := cl.Ping(ctx, nil); err != nil {
			log.Fatalf("failed to ping mongoDB : %v", err)
		}

		log.Println("Successfully connected to MongoDB")
		client = cl
	})

	return client
}

func GetCollection(dbName, collectionName string) *mongo.Collection {
	return ConnectMongoDB().Database(dbName).Collection(collectionName)
}
