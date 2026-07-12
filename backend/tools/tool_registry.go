package tools

import (
	"fmt"
	"log/slog"
	"os"
	"sort"
	"time"

	"backend/llm"
	"backend/memory"
	"backend/scratchpad"

	"github.com/redis/go-redis/v9"
)

type ToolRegistry struct {
	tools map[string]Tool
}

func NewToolRegistry(redisClient *redis.Client, memorySvc *memory.Service, scratchpadSvc *scratchpad.Service) *ToolRegistry {
	return newToolRegistry(redisClient, memorySvc, scratchpadSvc, os.Getenv("TAVILY_API_KEY"))
}

func newToolRegistry(redisClient *redis.Client, memorySvc *memory.Service, scratchpadSvc *scratchpad.Service, webSearchKey string) *ToolRegistry {
	r := &ToolRegistry{
		tools: make(map[string]Tool),
	}

	r.Register(NewCalculatorTool())
	slog.Info("tool registered", "name", "calculator")

	r.Register(NewHTTPTool(30*time.Second, newDedupCache(redisClient, "http_request")))
	slog.Info("tool registered", "name", "http_request")

	if webSearchKey != "" {
		r.Register(NewWebSearchTool(webSearchKey, 30*time.Second, newDedupCache(redisClient, "web_search")))
		slog.Info("tool registered", "name", "web_search")
	} else {
		slog.Info("tool skipped (TAVILY_API_KEY not set)", "name", "web_search")
	}

	if memorySvc != nil {
		r.Register(NewMemoryWriteTool(memorySvc))
		r.Register(NewMemoryReadTool(memorySvc))
		r.Register(NewMemorySearchTool(memorySvc))
		r.Register(NewMemoryPatchTool(memorySvc))
		r.Register(NewMemoryUpdateTool(memorySvc))
		r.Register(NewMemoryRetireTool(memorySvc))
		r.Register(NewMemoryRestoreTool(memorySvc))
		r.Register(NewMemoryHistoryTool(memorySvc))
		slog.Info("tool registered", "name", "memory_write,memory_read,memory_search,memory_patch,memory_update,memory_retire,memory_restore,memory_history")
	}

	if scratchpadSvc != nil {
		r.Register(NewScratchpadCreateTool(scratchpadSvc))
		r.Register(NewScratchpadAppendTool(scratchpadSvc))
		r.Register(NewScratchpadReplaceTool(scratchpadSvc))
		r.Register(NewScratchpadListTool(scratchpadSvc))
		r.Register(NewScratchpadGetSectionsTool(scratchpadSvc))
		r.Register(NewScratchpadReadSectionTool(scratchpadSvc))
		r.Register(NewScratchpadSearchTool(scratchpadSvc))
		slog.Info("tool registered", "name", "scratchpad_create,scratchpad_append_section,scratchpad_replace_section,scratchpad_list,scratchpad_get_sections,scratchpad_read_section,scratchpad_search")
	}

	slog.Info("tool registry ready", "count", len(r.tools))
	return r
}

func NewValidationRegistry() *ToolRegistry {
	return NewToolRegistry(nil, &memory.Service{}, &scratchpad.Service{})
}

// NewCatalogRegistry contains every embedded tool definition regardless of
// credentials. It is publication-only and its tools must never be executed.
func NewCatalogRegistry() *ToolRegistry {
	return newToolRegistry(nil, &memory.Service{}, &scratchpad.Service{}, "catalog-definition-only")
}

func (r *ToolRegistry) Register(t Tool) {
	r.tools[t.Name()] = t
}

func (r *ToolRegistry) Definitions() []llm.ToolDefinition {
	names := r.Names()
	sort.Strings(names)
	defs := make([]llm.ToolDefinition, 0, len(names))
	for _, name := range names {
		defs = append(defs, r.tools[name].Definition())
	}
	return defs
}

func (r *ToolRegistry) Names() []string {
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	return names
}

func (r *ToolRegistry) Get(name string) (Tool, error) {
	t, ok := r.tools[name]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrToolNotFound, name)
	}
	return t, nil
}

func (r *ToolRegistry) Has(name string) bool {
	_, ok := r.tools[name]
	return ok
}

// NewEmptyRegistry returns an initialised but empty ToolRegistry.
// Useful in tests that need to control exactly which tools are present.
func NewEmptyRegistry() *ToolRegistry {
	return &ToolRegistry{tools: make(map[string]Tool)}
}
