// Package reconciler turns durable deployment intent into bounded, leased
// reconciliation attempts. It owns controller lifecycle and MongoDB state
// transitions; a Kubernetes-specific implementation of Runtime owns cluster
// resource mechanics.
package reconciler

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"backend/deployment"
)

const (
	defaultWorkers           = 4
	defaultPollInterval      = time.Second
	defaultLeaseDuration     = 30 * time.Second
	defaultAttemptTimeout    = 12 * time.Minute
	defaultRetryBaseDelay    = time.Second
	defaultRetryMaximumDelay = 5 * time.Minute
	finalWriteTimeout        = 5 * time.Second
)

var ErrClaimLost = errors.New("deployment reconciliation claim lost")

// Store is the controller-facing side of durable deployment state. It is
// intentionally separate from deployment.DeployStateStore, which is consumed
// by user-intent application services.
type Store interface {
	ClaimDue(context.Context, deployment.ClaimRequest) (*deployment.DeployState, bool, error)
	RefreshClaim(context.Context, deployment.ClaimRef, time.Time, time.Duration) (bool, error)
	RecordStoragePlan(context.Context, deployment.StoragePlanObservation) (bool, error)
	RecordStorageReady(context.Context, deployment.StorageReadyObservation) (bool, error)
	RecordStorageMissing(context.Context, deployment.StorageMissingObservation) (bool, error)
	RecordProgress(context.Context, deployment.ProgressObservation) (bool, error)
	RecordReady(context.Context, deployment.ReadyObservation) (bool, error)
	RecordFailure(context.Context, deployment.FailureObservation) (bool, error)
	RecordDeleted(context.Context, deployment.ClaimRef, time.Time) (bool, error)
}

type RevisionReader interface {
	Get(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error)
}

type ProgressReporter func(phase deployment.DeploymentPhase, ready bool) error

// StorageReporter is the only way a runtime adapter may change durable storage
// observations. Both operations remain claim-fenced by the controller store.
type StorageReporter interface {
	Ready(binding deployment.StorageBindingObservation) error
	Missing() error
}

type storageReporter struct {
	ready   func(deployment.StorageBindingObservation) error
	missing func() error
}

func (r storageReporter) Ready(binding deployment.StorageBindingObservation) error {
	return r.ready(binding)
}

func (r storageReporter) Missing() error { return r.missing() }

// RunAttempt contains fully verified product state. Runtime must still enforce
// Kubernetes-side generation fencing before every cluster mutation.
type RunAttempt struct {
	State    deployment.DeployState
	Revision deployment.Revision
}

type DeleteAttempt struct {
	State deployment.DeployState
}

type RunResult struct {
	Endpoint  string
	Resources deployment.ResourceRefs
}

// Runtime is the narrow Kubernetes-only infrastructure boundary. It is not a
// generic orchestrator abstraction. The future implementation will resolve
// prerequisites, render and apply the AgentFlow workload, and verify readiness
// or deletion while honoring context cancellation and generation fencing.
type Runtime interface {
	ReconcileRun(ctx context.Context, attempt RunAttempt, report ProgressReporter, reportStorage StorageReporter) (RunResult, error)
	ReconcileDelete(ctx context.Context, attempt DeleteAttempt) error
}

// Error carries the stable, safe failure information that may be persisted in
// deployment status. Cause is retained for errors.Is/errors.As and logs but is
// never written to the deployment document.
type Error struct {
	Code      string
	Message   string
	Retryable bool
	Cause     error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Cause == nil {
		return e.Message
	}
	return fmt.Sprintf("%s: %v", e.Message, e.Cause)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func RetryableError(code, message string, cause error) error {
	return &Error{Code: code, Message: message, Retryable: true, Cause: cause}
}

func TerminalError(code, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}

type RetryPolicy struct {
	BaseDelay    time.Duration
	MaximumDelay time.Duration
}

// Delay returns deterministic per-claim jitter in the upper half of an
// exponentially growing window. Deterministic jitter keeps tests predictable
// while still distributing independent controller attempts in production.
func (p RetryPolicy) Delay(attempt int, claimToken string) time.Duration {
	base := p.BaseDelay
	if base <= 0 {
		base = defaultRetryBaseDelay
	}
	maximum := p.MaximumDelay
	if maximum <= 0 {
		maximum = defaultRetryMaximumDelay
	}
	if maximum < base {
		maximum = base
	}
	if attempt < 1 {
		attempt = 1
	}

	window := base
	for i := 1; i < attempt && window < maximum; i++ {
		if window > maximum/2 {
			window = maximum
			break
		}
		window *= 2
	}
	if window > maximum {
		window = maximum
	}

	half := window / 2
	if half <= 0 {
		return window
	}
	digest := sha256.Sum256([]byte(claimToken))
	randomPart := uint64(0)
	for _, value := range digest[:8] {
		randomPart = randomPart<<8 | uint64(value)
	}
	return half + time.Duration(randomPart%uint64(window-half+1))
}

type Config struct {
	Store     Store
	Revisions RevisionReader
	Runtime   Runtime
	Owner     string
	Logger    *slog.Logger

	Workers           int
	PollInterval      time.Duration
	LeaseDuration     time.Duration
	HeartbeatInterval time.Duration
	AttemptTimeout    time.Duration
	RetryPolicy       RetryPolicy

	Now      func() time.Time
	NewToken func() (string, error)
}

type Controller struct {
	store     Store
	revisions RevisionReader
	runtime   Runtime
	owner     string
	logger    *slog.Logger

	workers           int
	pollInterval      time.Duration
	leaseDuration     time.Duration
	heartbeatInterval time.Duration
	attemptTimeout    time.Duration
	retryPolicy       RetryPolicy

	now      func() time.Time
	newToken func() (string, error)
}

func New(cfg Config) (*Controller, error) {
	if cfg.Store == nil || cfg.Revisions == nil || cfg.Runtime == nil {
		return nil, errors.New("deployment reconciler: store, revisions, and runtime are required")
	}
	if err := deployment.ValidateClaimIdentity(cfg.Owner, "validation-token"); err != nil {
		return nil, fmt.Errorf("deployment reconciler: invalid owner: %w", err)
	}

	workers := cfg.Workers
	if workers <= 0 {
		workers = defaultWorkers
	}
	pollInterval := cfg.PollInterval
	if pollInterval <= 0 {
		pollInterval = defaultPollInterval
	}
	leaseDuration := cfg.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = defaultLeaseDuration
	}
	heartbeatInterval := cfg.HeartbeatInterval
	if heartbeatInterval <= 0 {
		heartbeatInterval = leaseDuration / 3
	}
	if heartbeatInterval <= 0 || heartbeatInterval >= leaseDuration {
		return nil, errors.New("deployment reconciler: heartbeat interval must be positive and shorter than the lease")
	}
	attemptTimeout := cfg.AttemptTimeout
	if attemptTimeout <= 0 {
		attemptTimeout = defaultAttemptTimeout
	}
	retryPolicy := cfg.RetryPolicy
	if retryPolicy.BaseDelay < 0 || retryPolicy.MaximumDelay < 0 ||
		(retryPolicy.BaseDelay > 0 && retryPolicy.MaximumDelay > 0 && retryPolicy.MaximumDelay < retryPolicy.BaseDelay) {
		return nil, errors.New("deployment reconciler: invalid retry policy")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	newToken := cfg.NewToken
	if newToken == nil {
		newToken = deployment.NewReconcileClaimToken
	}

	return &Controller{
		store: cfg.Store, revisions: cfg.Revisions, runtime: cfg.Runtime,
		owner: cfg.Owner, logger: logger, workers: workers,
		pollInterval: pollInterval, leaseDuration: leaseDuration,
		heartbeatInterval: heartbeatInterval, attemptTimeout: attemptTimeout,
		retryPolicy: retryPolicy, now: now, newToken: newToken,
	}, nil
}

// Run starts the bounded worker set and returns after ctx is cancelled and all
// active attempts have observed cancellation. Cancellation is normal shutdown,
// so Run returns nil rather than context.Canceled.
func (c *Controller) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("deployment reconciler: context is required")
	}
	var workers sync.WaitGroup
	workers.Add(c.workers)
	for worker := 0; worker < c.workers; worker++ {
		go func(worker int) {
			defer workers.Done()
			c.worker(ctx, worker)
		}(worker)
	}
	<-ctx.Done()
	workers.Wait()
	return nil
}

func (c *Controller) worker(ctx context.Context, worker int) {
	for ctx.Err() == nil {
		claimed, err := c.claimAndReconcile(ctx)
		if err != nil && ctx.Err() == nil {
			c.logger.Warn("deployment reconciler attempt failed", "worker", worker, "error", err)
		}
		if claimed {
			continue
		}
		timer := time.NewTimer(c.pollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
	}
}

func (c *Controller) claimAndReconcile(ctx context.Context) (bool, error) {
	token, err := c.newToken()
	if err != nil {
		return false, fmt.Errorf("deployment reconciler: create claim token: %w", err)
	}
	state, claimed, err := c.store.ClaimDue(ctx, deployment.ClaimRequest{
		Owner: c.owner, Token: token, Now: c.now(), LeaseDuration: c.leaseDuration,
	})
	if err != nil {
		return false, fmt.Errorf("deployment reconciler: claim due work: %w", err)
	}
	if !claimed {
		return false, nil
	}
	if state == nil || state.Reconcile.Claim == nil {
		return true, errors.New("deployment reconciler: store returned an incomplete claim")
	}
	c.reconcileClaim(ctx, state)
	return true, nil
}

func (c *Controller) reconcileClaim(parent context.Context, state *deployment.DeployState) {
	claim := claimRef(state)
	leaseCtx, cancelLease := context.WithCancel(parent)
	defer cancelLease()
	workCtx, cancelWork := context.WithTimeout(leaseCtx, c.attemptTimeout)
	defer cancelWork()

	var claimLost atomic.Bool
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		c.heartbeat(leaseCtx, cancelLease, claim, &claimLost)
	}()

	outcome, err := c.processClaim(workCtx, state, claim)
	if parent.Err() != nil || claimLost.Load() || errors.Is(err, ErrClaimLost) {
		cancelLease()
		<-heartbeatDone
		return
	}
	if errors.Is(workCtx.Err(), context.DeadlineExceeded) {
		err = RetryableError("reconcile_timeout", "deployment reconciliation attempt timed out", workCtx.Err())
	}

	finalCtx, cancelFinal := context.WithTimeout(leaseCtx, finalWriteTimeout)
	defer cancelFinal()
	if err != nil {
		c.recordFailure(finalCtx, state, claim, err)
	} else {
		c.recordSuccess(finalCtx, state, claim, outcome)
	}
	cancelLease()
	<-heartbeatDone
}

func (c *Controller) heartbeat(ctx context.Context, cancel context.CancelFunc, claim deployment.ClaimRef, lost *atomic.Bool) {
	ticker := time.NewTicker(c.heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refreshCtx, cancelRefresh := context.WithTimeout(ctx, minDuration(finalWriteTimeout, c.heartbeatInterval))
			refreshed, err := c.store.RefreshClaim(refreshCtx, claim, c.now(), c.leaseDuration)
			cancelRefresh()
			if err == nil && refreshed {
				continue
			}
			lost.Store(true)
			if err != nil {
				c.logger.Warn("deployment reconciler lost claim after refresh error",
					"deployment_id", claim.DeploymentID, "generation", claim.Generation, "error", err)
			}
			cancel()
			return
		}
	}
}

type attemptOutcome struct {
	ready   *RunResult
	deleted bool
}

func (c *Controller) processClaim(ctx context.Context, state *deployment.DeployState, claim deployment.ClaimRef) (attemptOutcome, error) {
	switch state.Desired.Action {
	case deployment.DesiredActionRun:
		revision, err := c.loadAndVerifyRevision(ctx, state)
		if err != nil {
			return attemptOutcome{}, err
		}
		plan, err := deployment.NewStoragePlan(state.UserID, state.DeploymentID, state.Desired.Target.Namespace)
		if err != nil {
			return attemptOutcome{}, TerminalError("storage_plan_invalid", "deployment storage plan is invalid", err)
		}
		if state.Storage.Phase == deployment.StoragePhaseMissing {
			return attemptOutcome{}, TerminalError(
				"storage_missing",
				"deployment retained storage is missing",
				deployment.ErrDeployStorageConflict,
			)
		}
		if state.Storage.Phase == deployment.StoragePhaseMigrationRequired {
			return attemptOutcome{}, TerminalError(
				"storage_migration_required",
				"deployment storage requires operator attention",
				deployment.ErrDeployStorageConflict,
			)
		}
		if state.Storage.Phase != "" && state.Storage.Phase != deployment.StoragePhaseUnprovisioned &&
			state.Storage.StoragePlan != plan {
			return attemptOutcome{}, TerminalError(
				"storage_plan_conflict",
				"deployment storage conflicts with retained storage",
				deployment.ErrDeployStorageConflict,
			)
		}
		applied, err := c.store.RecordStoragePlan(ctx, deployment.StoragePlanObservation{
			Claim: claim, Plan: plan, Now: c.now(),
		})
		if err != nil {
			if errors.Is(err, deployment.ErrDeployStorageConflict) {
				return attemptOutcome{}, TerminalError("storage_plan_conflict", "deployment storage conflicts with retained storage", err)
			}
			return attemptOutcome{}, RetryableError("storage_state_unavailable", "deployment storage state could not be recorded", err)
		}
		if !applied {
			return attemptOutcome{}, ErrClaimLost
		}
		if state.Storage.Phase == "" || state.Storage.Phase == deployment.StoragePhaseUnprovisioned {
			state.Storage = deployment.StorageState{
				StoragePlan: plan,
				Phase:       deployment.StoragePhasePlanned,
			}
		}
		if err := c.reportProgress(ctx, claim, deployment.DeploymentPhaseProvisioning, state.Observed.Ready); err != nil {
			return attemptOutcome{}, err
		}
		var storageReady atomic.Bool
		result, err := c.runtime.ReconcileRun(ctx, RunAttempt{State: *state, Revision: *revision},
			func(phase deployment.DeploymentPhase, ready bool) error {
				return c.reportProgress(ctx, claim, phase, ready)
			},
			storageReporter{ready: func(binding deployment.StorageBindingObservation) error {
				if err := c.reportStorageReady(ctx, claim, binding); err != nil {
					return err
				}
				storageReady.Store(true)
				return nil
			}, missing: func() error {
				return c.reportStorageMissing(ctx, claim)
			}})
		if err != nil {
			return attemptOutcome{}, err
		}
		if !storageReady.Load() {
			return attemptOutcome{}, TerminalError(
				"storage_not_verified",
				"runtime completed without verifying retained storage",
				nil,
			)
		}
		return attemptOutcome{ready: &result}, nil
	case deployment.DesiredActionDelete:
		if err := c.reportProgress(ctx, claim, deployment.DeploymentPhaseDeleting, state.Observed.Ready); err != nil {
			return attemptOutcome{}, err
		}
		if err := c.runtime.ReconcileDelete(ctx, DeleteAttempt{State: *state}); err != nil {
			return attemptOutcome{}, err
		}
		return attemptOutcome{deleted: true}, nil
	default:
		return attemptOutcome{}, TerminalError("invalid_desired_action", "deployment has an invalid desired action", nil)
	}
}

func (c *Controller) loadAndVerifyRevision(ctx context.Context, state *deployment.DeployState) (*deployment.Revision, error) {
	target := state.Desired.Target
	revision, err := c.revisions.Get(ctx, state.UserID, state.DeploymentID, target.Revision)
	if err != nil {
		if errors.Is(err, deployment.ErrRevisionNotFound) {
			return nil, TerminalError("revision_not_found", "selected deployment revision was not found", err)
		}
		return nil, RetryableError("revision_load_failed", "selected deployment revision could not be loaded", err)
	}
	if revision == nil || revision.UserID != state.UserID || revision.DeploymentID != state.DeploymentID ||
		revision.Revision != target.Revision || revision.ConfigHash != target.ConfigHash ||
		revision.SchemaVersion != target.SchemaVersion {
		return nil, TerminalError("revision_target_mismatch", "selected deployment revision does not match desired state", nil)
	}
	bundle, err := deployment.Parse(revision.BundleJSON)
	if err != nil {
		return nil, TerminalError("invalid_bundle", "selected deployment bundle failed integrity validation", err)
	}
	if bundle.DeploymentID != state.DeploymentID || bundle.ConfigHash != target.ConfigHash || bundle.SchemaVersion != target.SchemaVersion {
		return nil, TerminalError("bundle_target_mismatch", "selected deployment bundle does not match desired state", nil)
	}
	return revision, nil
}

func (c *Controller) reportProgress(ctx context.Context, claim deployment.ClaimRef, phase deployment.DeploymentPhase, ready bool) error {
	applied, err := c.store.RecordProgress(ctx, deployment.ProgressObservation{
		Claim: claim, Phase: phase, Ready: ready, Now: c.now(),
	})
	if err != nil {
		return fmt.Errorf("deployment reconciler: record %s progress: %w", phase, err)
	}
	if !applied {
		return ErrClaimLost
	}
	return nil
}

func (c *Controller) reportStorageReady(
	ctx context.Context,
	claim deployment.ClaimRef,
	binding deployment.StorageBindingObservation,
) error {
	applied, err := c.store.RecordStorageReady(ctx, deployment.StorageReadyObservation{
		Claim: claim, Binding: binding, Now: c.now(),
	})
	if err != nil {
		if errors.Is(err, deployment.ErrDeployStorageConflict) {
			return TerminalError(
				"storage_identity_conflict",
				"observed persistent storage does not match retained storage",
				err,
			)
		}
		return fmt.Errorf("deployment reconciler: record storage ready: %w", err)
	}
	if !applied {
		return ErrClaimLost
	}
	return nil
}

func (c *Controller) reportStorageMissing(ctx context.Context, claim deployment.ClaimRef) error {
	applied, err := c.store.RecordStorageMissing(ctx, deployment.StorageMissingObservation{
		Claim: claim,
		Now:   c.now(),
	})
	if err != nil {
		return fmt.Errorf("deployment reconciler: record storage missing: %w", err)
	}
	if !applied {
		return ErrClaimLost
	}
	return nil
}

func (c *Controller) recordSuccess(ctx context.Context, state *deployment.DeployState, claim deployment.ClaimRef, outcome attemptOutcome) {
	var (
		applied bool
		err     error
	)
	if outcome.deleted {
		applied, err = c.store.RecordDeleted(ctx, claim, c.now())
	} else if outcome.ready != nil {
		applied, err = c.store.RecordReady(ctx, deployment.ReadyObservation{
			Claim: claim, Target: state.Desired.Target, Endpoint: outcome.ready.Endpoint,
			Resources: outcome.ready.Resources, Now: c.now(),
		})
	} else {
		err = errors.New("reconciliation returned no terminal outcome")
	}
	if err != nil {
		c.logger.Warn("deployment reconciler could not record success",
			"deployment_id", state.DeploymentID, "generation", claim.Generation, "error", err)
		return
	}
	if !applied {
		c.logger.Info("deployment reconciler discarded stale success",
			"deployment_id", state.DeploymentID, "generation", claim.Generation)
	}
}

func (c *Controller) recordFailure(ctx context.Context, state *deployment.DeployState, claim deployment.ClaimRef, reconcileErr error) {
	failure := normalizedError(reconcileErr)
	now := c.now()
	observation := deployment.FailureObservation{
		Claim: claim, Code: failure.Code, Message: failure.Message,
		Retryable: failure.Retryable, OccurredAt: now,
	}
	if failure.Retryable {
		observation.RetryAt = now.Add(c.retryPolicy.Delay(state.Reconcile.Attempt, claim.Token))
	}
	applied, err := c.store.RecordFailure(ctx, observation)
	if err != nil {
		c.logger.Warn("deployment reconciler could not record failure",
			"deployment_id", state.DeploymentID, "generation", claim.Generation,
			"failure_code", failure.Code, "error", err)
		return
	}
	if !applied {
		c.logger.Info("deployment reconciler discarded stale failure",
			"deployment_id", state.DeploymentID, "generation", claim.Generation,
			"failure_code", failure.Code)
	}
}

func normalizedError(err error) Error {
	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		code, message := safeFailureFields(typed.Code, typed.Message)
		return Error{Code: code, Message: message, Retryable: typed.Retryable, Cause: typed.Cause}
	}
	code := "reconcile_failed"
	message := "deployment reconciliation failed"
	if errors.Is(err, context.DeadlineExceeded) {
		code = "reconcile_timeout"
		message = "deployment reconciliation attempt timed out"
	}
	return Error{Code: code, Message: message, Retryable: true, Cause: err}
}

func safeFailureFields(code, message string) (string, string) {
	if err := deployment.ValidateDeploymentError(code, message); err == nil {
		return code, message
	}
	if err := deployment.ValidateDeploymentError(code, "deployment reconciliation failed"); err != nil {
		code = "reconcile_failed"
	}

	message = strings.TrimSpace(message)
	var clean strings.Builder
	for len(message) > 0 && clean.Len() < deployment.MaxDeploymentErrorMessage {
		r, size := utf8.DecodeRuneInString(message)
		message = message[size:]
		if r < 0x20 || r == 0x7f || r == utf8.RuneError && size == 1 {
			r = ' '
		}
		if clean.Len()+utf8.RuneLen(r) > deployment.MaxDeploymentErrorMessage {
			break
		}
		clean.WriteRune(r)
	}
	result := strings.TrimSpace(clean.String())
	if result == "" {
		result = "deployment reconciliation failed"
	}
	return code, result
}

func claimRef(state *deployment.DeployState) deployment.ClaimRef {
	claim := state.Reconcile.Claim
	return deployment.ClaimRef{
		UserID: state.UserID, DeploymentID: state.DeploymentID,
		Generation: claim.Generation, Owner: claim.Owner, Token: claim.Token,
	}
}

func minDuration(first, second time.Duration) time.Duration {
	if first < second {
		return first
	}
	return second
}
