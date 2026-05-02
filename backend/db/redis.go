package db

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	redisClient *redis.Client
	redisOnce   sync.Once
)

func GetRedis() *redis.Client {
	redisOnce.Do(func() {
		url := os.Getenv("REDIS_URL")
		if url == "" {
			slog.Info("REDIS_URL not set, using default", "addr", "localhost:6379")
			url = "redis://localhost:6379"
		}

		opts, err := redis.ParseURL(url)
		if err != nil {
			slog.Warn("invalid REDIS_URL, tool dedup cache disabled", "error", err)
			return
		}

		client := redis.NewClient(opts)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := client.Ping(ctx).Err(); err != nil {
			slog.Warn("failed to connect to Redis, tool dedup cache disabled", "error", err)
			return
		}

		slog.Info("connected to Redis", "addr", opts.Addr)
		redisClient = client
	})

	return redisClient
}
