package deployment

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var ErrDeployStateNotFound = errors.New("deployment state not found")

var nonDNSLabelCharRE = regexp.MustCompile(`[^a-z0-9]+`)

type DeployState struct {
	UserID       string
	DeploymentID string
	Revision     int
	ConfigHash   string
	ResourceName string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// ResourceName returns the immutable Kubernetes object/PVC name for one
// published revision. Including both revision and hash makes the selected
// artifact visible while preventing a changed bundle from reusing its PVC.
func ResourceName(deploymentID string, revision int, configHash string) (string, error) {
	if strings.TrimSpace(deploymentID) == "" || revision <= 0 || !hashRE.MatchString(configHash) {
		return "", fmt.Errorf("deployment: deployment id, positive revision, and canonical config hash are required")
	}
	base := strings.Trim(nonDNSLabelCharRE.ReplaceAllString(strings.ToLower(deploymentID), "-"), "-")
	if base == "" {
		base = "deployment"
	}
	suffix := fmt.Sprintf("-r%d-%s", revision, configHash[:12])
	const prefix = "af-"
	maxBase := 63 - len(prefix) - len(suffix)
	if maxBase <= 0 {
		return "", fmt.Errorf("deployment: revision is too large for a resource name")
	}
	if len(base) > maxBase {
		base = strings.TrimRight(base[:maxBase], "-")
	}
	if base == "" {
		base = "deployment"
	}
	return prefix + base + suffix, nil
}
