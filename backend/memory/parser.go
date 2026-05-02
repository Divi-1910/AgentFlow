package memory

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

func Parse(raw []byte) (MemoryDocument, error) {
	content := strings.ReplaceAll(string(raw), "\r\n", "\n")
	lines := strings.Split(content, "\n")
	if len(lines) < 3 || lines[0] != "---" {
		return MemoryDocument{}, fmt.Errorf("%w: missing frontmatter start", ErrInvalidDocument)
	}

	end := -1
	for i := 1; i < len(lines); i++ {
		if lines[i] == "---" {
			end = i
			break
		}
	}
	if end == -1 {
		return MemoryDocument{}, fmt.Errorf("%w: missing frontmatter end", ErrInvalidDocument)
	}

	fields := make(map[string]string)
	for _, line := range lines[1:end] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return MemoryDocument{}, fmt.Errorf("%w: malformed frontmatter line %q", ErrInvalidDocument, line)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			return MemoryDocument{}, fmt.Errorf("%w: malformed frontmatter line %q", ErrInvalidDocument, line)
		}
		if _, exists := fields[key]; exists {
			return MemoryDocument{}, fmt.Errorf("%w: duplicate frontmatter key %q", ErrInvalidDocument, key)
		}
		fields[key] = value
	}

	bodyLines := lines[end+1:]
	bodyStartLine := end + 2
	if len(bodyLines) > 0 && bodyLines[0] == "" {
		bodyLines = bodyLines[1:]
		bodyStartLine++
	}
	body := strings.TrimRight(strings.Join(bodyLines, "\n"), "\n")
	if strings.TrimSpace(body) == "" {
		return MemoryDocument{}, fmt.Errorf("%w: body is empty", ErrInvalidDocument)
	}

	doc, err := parseFrontmatter(fields)
	if err != nil {
		return MemoryDocument{}, err
	}
	doc.Body = body
	doc.BodyStartLine = bodyStartLine
	return doc, nil
}

func parseFrontmatter(fields map[string]string) (MemoryDocument, error) {
	required := []string{"version", "id", "type", "scope", "agent_id", "thread_id", "importance", "created_at"}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return MemoryDocument{}, fmt.Errorf("%w: missing %s", ErrInvalidDocument, key)
		}
	}

	version, err := strconv.Atoi(fields["version"])
	if err != nil || version != DocumentVersion {
		return MemoryDocument{}, fmt.Errorf("%w: unsupported version", ErrInvalidDocument)
	}
	if !validType(fields["type"]) {
		return MemoryDocument{}, ErrInvalidType
	}
	if !validScope(fields["scope"]) {
		return MemoryDocument{}, ErrInvalidScope
	}

	importance, err := strconv.ParseFloat(fields["importance"], 64)
	if err != nil {
		return MemoryDocument{}, fmt.Errorf("%w: invalid importance", ErrInvalidDocument)
	}
	if importance < 0 || importance > 1 {
		return MemoryDocument{}, fmt.Errorf("%w: importance out of range", ErrInvalidDocument)
	}

	createdAt, err := time.Parse(time.RFC3339, fields["created_at"])
	if err != nil {
		return MemoryDocument{}, fmt.Errorf("%w: invalid created_at", ErrInvalidDocument)
	}

	var expiresAt *time.Time
	if rawExpires, ok := fields["expires_at"]; ok {
		parsed, err := time.Parse(time.RFC3339, rawExpires)
		if err != nil {
			return MemoryDocument{}, fmt.Errorf("%w: invalid expires_at", ErrInvalidDocument)
		}
		if !parsed.After(createdAt) {
			return MemoryDocument{}, fmt.Errorf("%w: expires_at must be later than created_at", ErrInvalidDocument)
		}
		expiresAt = &parsed
	}

	return MemoryDocument{
		Version:    version,
		ID:         fields["id"],
		Type:       fields["type"],
		Scope:      fields["scope"],
		AgentID:    fields["agent_id"],
		ThreadID:   fields["thread_id"],
		Importance: importance,
		CreatedAt:  createdAt,
		ExpiresAt:  expiresAt,
	}, nil
}
