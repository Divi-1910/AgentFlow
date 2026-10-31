package agent

// RunListFilter contains product-level filters for top-level owned runs.
// Child/delegate runs are deliberately excluded by repository implementations.
type RunListFilter struct {
	ThreadID   string
	ResourceID string
	Statuses   []string
}
