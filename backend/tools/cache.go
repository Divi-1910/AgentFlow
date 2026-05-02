package tools

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

const dedupTTL = 7 * 24 * time.Hour

type dedupCache struct {
	client *redis.Client
	prefix string
}

func newDedupCache(client *redis.Client, tool string) *dedupCache {
	return &dedupCache{
		client: client,
		prefix: "agentflow:dedup:" + tool,
	}
}

func (c *dedupCache) key(callID string) string {
	return c.prefix + ":" + callID
}

func (c *dedupCache) Get(callID string) (*ToolResult, bool) {
	if c.client == nil || callID == "" {
		return nil, false
	}
	data, err := c.client.Get(context.Background(), c.key(callID)).Bytes()
	if err != nil {
		return nil, false
	}
	var r ToolResult
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, false
	}
	return &r, true
}

func (c *dedupCache) Put(callID string, r *ToolResult) {
	if c.client == nil || callID == "" || r == nil {
		return
	}
	data, err := json.Marshal(r)
	if err != nil {
		return
	}
	_ = c.client.Set(context.Background(), c.key(callID), data, dedupTTL).Err()
}
