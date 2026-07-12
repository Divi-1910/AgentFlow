package deployment

import (
	"errors"
	"time"
)

var ErrRevisionNotFound = errors.New("deployment revision not found")

type RevisionInput struct {
	UserID        string
	DeploymentID  string
	RootAgentID   string
	ConfigHash    string
	SchemaVersion int
	BundleJSON    []byte
}

type Revision struct {
	UserID        string
	DeploymentID  string
	RootAgentID   string
	Revision      int
	ConfigHash    string
	SchemaVersion int
	BundleJSON    []byte
	CreatedAt     time.Time
}
