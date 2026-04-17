package tools

// Has reports whether a tool with the given name is registered.
func (r *ToolRegistry) Has(name string) bool {
	_, ok := r.tools[name]
	return ok
}

// ReplayPolicy returns the replay safety policy for a registered tool.
// Returns ReplaySafe as the safe default for unknown names.
func (r *ToolRegistry) ReplayPolicy(name string) ReplayPolicy {
	if p, ok := r.policies[name]; ok {
		return p
	}
	return ReplaySafe
}
