package tools

import (
	"backend/llm"
	"fmt"
	"log"
	"os"
	"time"
)

type ToolRegistry struct {
	tools map[string]Tool
}

func NewToolRegistry() *ToolRegistry {
	r := &ToolRegistry{
		tools: make(map[string]Tool),
	}

	r.Register(NewCalculatorTool())
	log.Println("calculator tool registered")

	r.Register(NewHTTPTool(30 * time.Second))
	log.Println("http_request tool registered")

	if key := os.Getenv("TAVILY_API_KEY"); key != "" {
		r.Register(NewWebSearchTool(key, 30*time.Second))
		log.Println("web_search tool registered")
	} else {
		log.Println("web_search tool skipped (TAVILY_API_KEY not set)")
	}
	log.Printf("%d tool(s) registered", len(r.tools))
	return r

}

func (r *ToolRegistry) Register(t Tool) {
	r.tools[t.Name()] = t
}

func (r *ToolRegistry) Definitions() []llm.ToolDefinition {
	defs := make([]llm.ToolDefinition, 0, len(r.tools))
	for _, t := range r.tools {
		defs = append(defs, t.Definition())
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
