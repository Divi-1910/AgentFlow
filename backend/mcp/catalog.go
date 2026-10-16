package mcp

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	serverIDRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	aliasRE    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// CatalogEntry is AgentFlow-owned MCP server metadata. Agents persist only
// ServerID; trusted execution boundaries resolve the appropriate URL.
type CatalogEntry struct {
	ServerID      string
	Name          string
	Description   string
	Alias         string
	StudioURL     string
	DeploymentURL string
	Enabled       bool
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

func ValidateServerID(serverID string) error {
	if !serverIDRE.MatchString(serverID) {
		return fmt.Errorf("server_id %q must match [a-z0-9][a-z0-9-]{0,62}", serverID)
	}
	return nil
}

func ValidateCatalogIdentity(entry CatalogEntry) error {
	if err := ValidateServerID(entry.ServerID); err != nil {
		return err
	}
	if strings.TrimSpace(entry.Name) == "" {
		return fmt.Errorf("MCP server %q requires a name", entry.ServerID)
	}
	if !aliasRE.MatchString(entry.Alias) {
		return fmt.Errorf("MCP server %q alias must match [A-Za-z0-9_-]{1,64}", entry.ServerID)
	}
	return nil
}
