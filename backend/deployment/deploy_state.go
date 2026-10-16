package deployment

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	DeployStateRecordVersion               = 3
	PreviousDeployStateRecordVersion       = 2
	MaxClaimIdentityBytes                  = 128
	MaxDeploymentErrorCode                 = 64
	MaxDeploymentErrorMessage              = 4096
	DefaultStorageCapacityBytes      int64 = 5 << 30
)

var (
	ErrDeployStateNotFound          = errors.New("deployment state not found")
	ErrDeployStateConflict          = errors.New("deployment state conflict")
	ErrDeployStateMigrationRequired = errors.New("deployment state migration required")
	ErrDeployStateRollback          = errors.New("deployment state cannot move to an older revision")
	ErrDeployStateClaim             = errors.New("deployment reconciliation claim is invalid")
	ErrDeployStateTarget            = errors.New("deployment target is invalid")
	ErrDeployStorageConflict        = errors.New("deployment storage conflict")
)

var (
	runtimeImageDigestRE = regexp.MustCompile(`^[^\s@]+@sha256:[0-9a-f]{64}$`)
	namespaceRE          = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)
	errorCodeRE          = regexp.MustCompile(`^[a-z][a-z0-9_.-]*$`)
	storageIDRE          = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type StoragePhase string

const (
	StoragePhaseUnprovisioned     StoragePhase = "unprovisioned"
	StoragePhasePlanned           StoragePhase = "planned"
	StoragePhaseReady             StoragePhase = "ready"
	StoragePhaseRetained          StoragePhase = "retained"
	StoragePhaseMissing           StoragePhase = "missing"
	StoragePhaseMigrationRequired StoragePhase = "migration_required"
)

type StorageAccessMode string

const StorageAccessModeReadWriteOnce StorageAccessMode = "ReadWriteOnce"

type StorageVolumeMode string

const StorageVolumeModeFilesystem StorageVolumeMode = "Filesystem"

type StorageClassPolicy string

const StorageClassPolicyClusterDefault StorageClassPolicy = "cluster_default"

type StoragePlan struct {
	StorageID              string
	Namespace              string
	PVCName                string
	RequestedCapacityBytes int64
	AccessMode             StorageAccessMode
	VolumeMode             StorageVolumeMode
	StorageClassPolicy     StorageClassPolicy
}

type StorageState struct {
	StoragePlan
	Phase              StoragePhase
	PVCUID             string
	StorageClassName   string
	CapacityBytes      int64
	LegacyPVCName      string
	LegacyPVCNamespace string
	PlannedAt          time.Time
	LastObservedAt     time.Time
}

type StorageBindingObservation struct {
	StorageID        string
	Namespace        string
	PVCName          string
	PVCUID           string
	StorageClassName string
	CapacityBytes    int64
	AccessMode       StorageAccessMode
	VolumeMode       StorageVolumeMode
}

type DesiredAction string

const (
	DesiredActionRun    DesiredAction = "run"
	DesiredActionDelete DesiredAction = "delete"
)

type DeploymentPhase string

const (
	DeploymentPhasePending      DeploymentPhase = "pending"
	DeploymentPhaseProvisioning DeploymentPhase = "provisioning"
	DeploymentPhaseStarting     DeploymentPhase = "starting"
	DeploymentPhaseReady        DeploymentPhase = "ready"
	DeploymentPhaseDegraded     DeploymentPhase = "degraded"
	DeploymentPhaseFailed       DeploymentPhase = "failed"
	DeploymentPhaseDeleting     DeploymentPhase = "deleting"
	DeploymentPhaseDeleted      DeploymentPhase = "deleted"
)

// DeploymentTarget is the immutable input a generation asks the controller to
// realize. Namespace and RuntimeImage are resolved platform policy, not values
// accepted directly from an untrusted deployment API payload.
type DeploymentTarget struct {
	Revision      int
	ConfigHash    string
	SchemaVersion int
	Namespace     string
	RuntimeImage  string
}

type DesiredState struct {
	Generation  int64
	Action      DesiredAction
	Target      DeploymentTarget
	RequestedAt time.Time
}

type ResourceRefs struct {
	Namespace          string
	DeploymentName     string
	ServiceName        string
	DeliverySecretName string
	RuntimeSecretName  string
}

type DeploymentError struct {
	Code       string
	Message    string
	Retryable  bool
	Generation int64
	OccurredAt time.Time
}

// ObservedState describes infrastructure the controller has actually
// inspected. Target is nil until a running generation has been verified.
type ObservedState struct {
	Generation       int64
	Phase            DeploymentPhase
	Target           *DeploymentTarget
	Ready            bool
	Endpoint         string
	Resources        ResourceRefs
	LastError        *DeploymentError
	LastTransitionAt time.Time
}

type ReconcileClaim struct {
	Generation     int64
	Token          string
	Owner          string
	LeaseExpiresAt time.Time
}

type ReconcileState struct {
	DueAt               *time.Time
	Attempt             int
	ProcessedGeneration int64
	Claim               *ReconcileClaim
}

type ClaimRequest struct {
	Owner         string
	Token         string
	Now           time.Time
	LeaseDuration time.Duration
}

type ClaimRef struct {
	UserID       string
	DeploymentID string
	Generation   int64
	Owner        string
	Token        string
}

type ProgressObservation struct {
	Claim ClaimRef
	Phase DeploymentPhase
	Ready bool
	Now   time.Time
}

type ReadyObservation struct {
	Claim     ClaimRef
	Target    DeploymentTarget
	Endpoint  string
	Resources ResourceRefs
	Now       time.Time
}

type StoragePlanObservation struct {
	Claim ClaimRef
	Plan  StoragePlan
	Now   time.Time
}

type StorageReadyObservation struct {
	Claim   ClaimRef
	Binding StorageBindingObservation
	Now     time.Time
}

// StorageMissingObservation records that storage which had already been
// durably bound can no longer be found. It is deliberately separate from a
// generic deployment failure: silently provisioning a replacement PVC would
// lose the agent's retained memory and scratchpad history.
type StorageMissingObservation struct {
	Claim ClaimRef
	Now   time.Time
}

type FailureObservation struct {
	Claim      ClaimRef
	Code       string
	Message    string
	Retryable  bool
	RetryAt    time.Time
	OccurredAt time.Time
}

type LegacyStateMigration struct {
	UserID             string
	DeploymentID       string
	Target             DeploymentTarget
	LegacyResourceName string
	MigratedAt         time.Time
}

type V2StateMigration struct {
	UserID       string
	DeploymentID string
	MigratedAt   time.Time
}

// StateMigrationSource is a read-only projection used by the explicit
// operator migration planner. It contains no credentials or bundle bytes.
type StateMigrationSource struct {
	RecordVersion      int
	UserID             string
	DeploymentID       string
	LegacyRevision     int
	LegacyConfigHash   string
	LegacyResourceName string
	DesiredTarget      DeploymentTarget
	LegacyPVCName      string
	LegacyPVCNamespace string
}

type MigrationState struct {
	LegacyResourceName string
	MigratedAt         time.Time
}

// DeployState is the product-level source of truth for one owned deployment.
// It contains no bundle bytes, delivery credentials, or runtime secrets.
type DeployState struct {
	RecordVersion int
	UserID        string
	DeploymentID  string
	Desired       DesiredState
	Observed      ObservedState
	Storage       StorageState
	Reconcile     ReconcileState
	Migration     *MigrationState
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

func NewStoragePlan(ownerID, deploymentID, namespace string) (StoragePlan, error) {
	if strings.TrimSpace(ownerID) == "" || strings.TrimSpace(deploymentID) == "" {
		return StoragePlan{}, fmt.Errorf("%w: owner and deployment are required", ErrDeployStorageConflict)
	}
	if len(namespace) == 0 || len(namespace) > 63 || !namespaceRE.MatchString(namespace) {
		return StoragePlan{}, fmt.Errorf("%w: namespace must be a DNS-1123 label", ErrDeployStorageConflict)
	}
	digest := sha256.Sum256([]byte(ownerID + "\x00" + deploymentID))
	storageID := hex.EncodeToString(digest[:])
	plan := StoragePlan{
		StorageID:              storageID,
		Namespace:              namespace,
		PVCName:                "af-storage-" + storageID[:40],
		RequestedCapacityBytes: DefaultStorageCapacityBytes,
		AccessMode:             StorageAccessModeReadWriteOnce,
		VolumeMode:             StorageVolumeModeFilesystem,
		StorageClassPolicy:     StorageClassPolicyClusterDefault,
	}
	return plan, nil
}

func ValidateStoragePlan(plan StoragePlan) error {
	if !storageIDRE.MatchString(plan.StorageID) {
		return fmt.Errorf("%w: storage id must be a lowercase sha256 digest", ErrDeployStorageConflict)
	}
	if len(plan.Namespace) == 0 || len(plan.Namespace) > 63 || !namespaceRE.MatchString(plan.Namespace) {
		return fmt.Errorf("%w: namespace must be a DNS-1123 label", ErrDeployStorageConflict)
	}
	if !validDNSSubdomain(plan.PVCName) {
		return fmt.Errorf("%w: PVC name must be a DNS-1123 subdomain", ErrDeployStorageConflict)
	}
	if plan.RequestedCapacityBytes != DefaultStorageCapacityBytes ||
		plan.AccessMode != StorageAccessModeReadWriteOnce ||
		plan.VolumeMode != StorageVolumeModeFilesystem ||
		plan.StorageClassPolicy != StorageClassPolicyClusterDefault {
		return fmt.Errorf("%w: unsupported storage contract", ErrDeployStorageConflict)
	}
	return nil
}

func ValidateStorageBinding(binding StorageBindingObservation) error {
	plan := StoragePlan{
		StorageID:              binding.StorageID,
		Namespace:              binding.Namespace,
		PVCName:                binding.PVCName,
		RequestedCapacityBytes: DefaultStorageCapacityBytes,
		AccessMode:             binding.AccessMode,
		VolumeMode:             binding.VolumeMode,
		StorageClassPolicy:     StorageClassPolicyClusterDefault,
	}
	if err := ValidateStoragePlan(plan); err != nil {
		return err
	}
	if err := validateVisibleASCII(binding.PVCUID, MaxClaimIdentityBytes); err != nil {
		return fmt.Errorf("%w: PVC UID: %v", ErrDeployStorageConflict, err)
	}
	if !validDNSSubdomain(binding.StorageClassName) {
		return fmt.Errorf("%w: storage class must be a DNS-1123 subdomain", ErrDeployStorageConflict)
	}
	if binding.CapacityBytes < DefaultStorageCapacityBytes {
		return fmt.Errorf("%w: observed capacity is smaller than requested capacity", ErrDeployStorageConflict)
	}
	return nil
}

func validDNSSubdomain(value string) bool {
	if len(value) == 0 || len(value) > 253 {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || !namespaceRE.MatchString(label) {
			return false
		}
	}
	return true
}

func ValidateDeploymentTarget(target DeploymentTarget) error {
	if target.Revision <= 0 || target.SchemaVersion <= 0 || !hashRE.MatchString(target.ConfigHash) {
		return fmt.Errorf("%w: positive revision and schema version plus canonical config hash are required", ErrDeployStateTarget)
	}
	if len(target.Namespace) == 0 || len(target.Namespace) > 63 || !namespaceRE.MatchString(target.Namespace) {
		return fmt.Errorf("%w: namespace must be a DNS-1123 label", ErrDeployStateTarget)
	}
	if !runtimeImageDigestRE.MatchString(target.RuntimeImage) {
		return fmt.Errorf("%w: runtime image must be pinned by a lowercase sha256 digest", ErrDeployStateTarget)
	}
	return nil
}

func ValidateDesiredAction(action DesiredAction) error {
	switch action {
	case DesiredActionRun, DesiredActionDelete:
		return nil
	default:
		return fmt.Errorf("%w: unknown desired action %q", ErrDeployStateConflict, action)
	}
}

func ValidateProgressPhase(phase DeploymentPhase) error {
	switch phase {
	case DeploymentPhaseProvisioning, DeploymentPhaseStarting, DeploymentPhaseDeleting:
		return nil
	default:
		return fmt.Errorf("%w: phase %q is not a progress phase", ErrDeployStateConflict, phase)
	}
}

func ValidateDeploymentError(code, message string) error {
	if len(code) == 0 || len(code) > MaxDeploymentErrorCode || !errorCodeRE.MatchString(code) {
		return fmt.Errorf("%w: error code must be a bounded lowercase identifier", ErrDeployStateConflict)
	}
	if strings.TrimSpace(message) == "" || len(message) > MaxDeploymentErrorMessage {
		return fmt.Errorf("%w: error message must contain 1 to %d bytes", ErrDeployStateConflict, MaxDeploymentErrorMessage)
	}
	for i := 0; i < len(message); i++ {
		if message[i] < 0x20 || message[i] == 0x7f {
			return fmt.Errorf("%w: error message must not contain control bytes", ErrDeployStateConflict)
		}
	}
	return nil
}

func ValidateClaimIdentity(owner, token string) error {
	if err := validateVisibleASCII(owner, MaxClaimIdentityBytes); err != nil {
		return fmt.Errorf("%w: owner: %v", ErrDeployStateClaim, err)
	}
	if err := validateVisibleASCII(token, MaxClaimIdentityBytes); err != nil {
		return fmt.Errorf("%w: token: %v", ErrDeployStateClaim, err)
	}
	return nil
}

func NewReconcileClaimToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("deployment: generate reconciliation claim token: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func validateVisibleASCII(value string, max int) error {
	if len(value) == 0 || len(value) > max {
		return fmt.Errorf("must contain 1 to %d bytes", max)
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return errors.New("must contain visible ASCII without whitespace")
		}
	}
	return nil
}
