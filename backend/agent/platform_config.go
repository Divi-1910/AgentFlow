package agent

import (
	"fmt"
	"os"
	"strings"
)

// PlatformConfig holds the static <platform> block that is prepended to every
// system prompt. Loaded once at startup from platform.xml and reused for the
// lifetime of the process.
//
// The body is intentionally stored as a single string and emitted verbatim by
// the ContextBuilder. Keep it free of per-request template values (date, IDs)
// so the static prefix stays byte-identical across turns — that is the
// invariant prompt caching relies on.
type PlatformConfig struct {
	Body string
}

// LoadPlatformConfig reads the platform XML file from path. It does not parse
// the XML structurally — the file is the source of truth for the wire format
// of the <platform> block. The caller is responsible for shaping the file
// correctly.
func LoadPlatformConfig(path string) (*PlatformConfig, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("platform config: path is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("platform config: read %s: %w", path, err)
	}
	body := strings.TrimSpace(string(raw))
	if body == "" {
		return nil, fmt.Errorf("platform config: %s is empty", path)
	}
	return &PlatformConfig{Body: body}, nil
}
