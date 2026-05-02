package memory

import (
	"fmt"
	"strings"
	"time"
)

func Render(doc MemoryDocument) (string, error) {
	if doc.Body == "" {
		return "", fmt.Errorf("%w: body is required", ErrInvalidDocument)
	}
	if !validScope(doc.Scope) {
		return "", ErrInvalidScope
	}
	if !validType(doc.Type) {
		return "", ErrInvalidType
	}

	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(fmt.Sprintf("version: %d\n", doc.Version))
	b.WriteString(fmt.Sprintf("id: %s\n", doc.ID))
	b.WriteString(fmt.Sprintf("type: %s\n", doc.Type))
	b.WriteString(fmt.Sprintf("scope: %s\n", doc.Scope))
	b.WriteString(fmt.Sprintf("agent_id: %s\n", doc.AgentID))
	b.WriteString(fmt.Sprintf("thread_id: %s\n", doc.ThreadID))
	b.WriteString(fmt.Sprintf("importance: %.2f\n", doc.Importance))
	b.WriteString(fmt.Sprintf("created_at: %s\n", doc.CreatedAt.UTC().Format(time.RFC3339)))
	if doc.ExpiresAt != nil {
		b.WriteString(fmt.Sprintf("expires_at: %s\n", doc.ExpiresAt.UTC().Format(time.RFC3339)))
	}
	b.WriteString("---\n\n")
	b.WriteString(doc.Body)
	if !strings.HasSuffix(doc.Body, "\n") {
		b.WriteString("\n")
	}
	return b.String(), nil
}
