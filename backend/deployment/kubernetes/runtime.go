package kubernetes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"backend/deployment"
	"backend/deployment/delivery"
	"backend/deployment/reconciler"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/apimachinery/pkg/util/wait"
	kubeclient "k8s.io/client-go/kubernetes"
)

const (
	defaultPollInterval = 2 * time.Second
	defaultReadyTimeout = 10 * time.Minute
)

type StateReader interface {
	Get(ctx context.Context, userID, deploymentID string) (*deployment.DeployState, error)
}

type DeliveryCredentials interface {
	Issue(ctx context.Context, request delivery.IssueRequest) (*delivery.Credential, error)
	RevokeGeneration(ctx context.Context, userID, deploymentID string, generation int64) error
}

type RuntimeConfig struct {
	Client                    kubeclient.Interface
	States                    StateReader
	Delivery                  DeliveryCredentials
	ArtifactBaseURL           string
	CredentialSourceNamespace string
	CredentialSourceName      string
	PollInterval              time.Duration
	ReadyTimeout              time.Duration
}

// Runtime is the live Kubernetes implementation of the reconciler's narrow
// infrastructure boundary. Product policy remains in deployment.Service and
// retry/lease policy remains in reconciler.Controller.
type Runtime struct {
	client                    kubeclient.Interface
	states                    StateReader
	delivery                  DeliveryCredentials
	artifactBaseURL           *url.URL
	credentialSourceNamespace string
	credentialSourceName      string
	pollInterval              time.Duration
	readyTimeout              time.Duration
}

var _ reconciler.Runtime = (*Runtime)(nil)

func NewRuntime(cfg RuntimeConfig) (*Runtime, error) {
	if cfg.Client == nil || cfg.States == nil || cfg.Delivery == nil {
		return nil, errors.New("kubernetes runtime: client, deployment states, and delivery service are required")
	}
	baseURL, err := url.Parse(strings.TrimSpace(cfg.ArtifactBaseURL))
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil ||
		baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("kubernetes runtime: artifact base URL must be an absolute HTTPS URL without credentials, query, or fragment")
	}
	if errs := validation.IsDNS1123Label(cfg.CredentialSourceNamespace); len(errs) != 0 {
		return nil, fmt.Errorf("kubernetes runtime: invalid credential source namespace: %s", strings.Join(errs, "; "))
	}
	if errs := validation.IsDNS1123Subdomain(cfg.CredentialSourceName); len(errs) != 0 {
		return nil, fmt.Errorf("kubernetes runtime: invalid credential source Secret name: %s", strings.Join(errs, "; "))
	}
	pollInterval := cfg.PollInterval
	if pollInterval <= 0 {
		pollInterval = defaultPollInterval
	}
	readyTimeout := cfg.ReadyTimeout
	if readyTimeout <= 0 {
		readyTimeout = defaultReadyTimeout
	}
	return &Runtime{
		client: cfg.Client, states: cfg.States, delivery: cfg.Delivery, artifactBaseURL: baseURL,
		credentialSourceNamespace: cfg.CredentialSourceNamespace,
		credentialSourceName:      cfg.CredentialSourceName,
		pollInterval:              pollInterval, readyTimeout: readyTimeout,
	}, nil
}

func (r *Runtime) ReconcileRun(
	ctx context.Context,
	attempt reconciler.RunAttempt,
	report reconciler.ProgressReporter,
	reportStorage reconciler.StorageReporter,
) (reconciler.RunResult, error) {
	state := attempt.State
	if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
		return reconciler.RunResult{}, err
	}
	bundle, err := deployment.Parse(attempt.Revision.BundleJSON)
	if err != nil {
		return reconciler.RunResult{}, reconciler.TerminalError("invalid_bundle", "selected deployment bundle failed integrity validation", err)
	}
	credentialPlan, err := deployment.PlanRuntimeCredentials(bundle)
	if err != nil {
		return reconciler.RunResult{}, reconciler.TerminalError("runtime_credentials_invalid", "runtime credential requirements are invalid", err)
	}
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		return reconciler.RunResult{}, reconciler.TerminalError("resource_identity_invalid", "deployment resource identity is invalid", err)
	}
	deliverySecretName := name + "-delivery"
	runtimeSecretName := name + "-runtime"

	pvc, err := r.ensurePVC(ctx, state, reportStorage)
	if err != nil {
		return reconciler.RunResult{}, err
	}

	sourceSecret, err := r.client.CoreV1().Secrets(r.credentialSourceNamespace).Get(
		ctx,
		r.credentialSourceName,
		metav1.GetOptions{},
	)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return reconciler.RunResult{}, reconciler.TerminalError(
				"runtime_credentials_unavailable",
				"AgentFlow runtime credentials are unavailable",
				err,
			)
		}
		return reconciler.RunResult{}, kubeFailure("read credential source Secret", err)
	}

	if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.delivery.RevokeGeneration(ctx, state.UserID, state.DeploymentID, state.Desired.Generation); err != nil {
		return reconciler.RunResult{}, reconciler.RetryableError(
			"delivery_credentials_unavailable",
			"deployment bundle credentials could not be rotated",
			err,
		)
	}
	credential, err := r.delivery.Issue(ctx, delivery.IssueRequest{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
	})
	if err != nil {
		return reconciler.RunResult{}, reconciler.RetryableError(
			"delivery_credentials_unavailable",
			"deployment bundle credentials could not be issued",
			err,
		)
	}
	runtimeToken, err := deployment.NewRuntimeAPIToken()
	if err != nil {
		return reconciler.RunResult{}, reconciler.RetryableError(
			"runtime_credentials_unavailable",
			"runtime access credentials could not be generated",
			err,
		)
	}

	deliverySecret, err := RenderDeliverySecret(DeliverySecretInput{
		Namespace: state.Desired.Target.Namespace, Name: deliverySecretName,
		OwnerID: state.UserID, DeploymentID: state.DeploymentID, Credential: credential,
	})
	if err != nil {
		return reconciler.RunResult{}, reconciler.TerminalError("delivery_secret_invalid", "deployment bundle Secret is invalid", err)
	}
	runtimeSecret, err := RenderRuntimeSecret(RuntimeSecretInput{
		Namespace: state.Desired.Target.Namespace, Name: runtimeSecretName,
		OwnerID: state.UserID, DeploymentID: state.DeploymentID,
		Generation: state.Desired.Generation, Revision: state.Desired.Target.Revision,
		Plan: credentialPlan, Source: sourceSecret, RuntimeAPIToken: runtimeToken,
	})
	if err != nil {
		code := "runtime_secret_invalid"
		message := "runtime Secret is invalid"
		if errors.Is(err, ErrRuntimeCredentialUnavailable) {
			code = "runtime_credentials_unavailable"
			message = "required AgentFlow runtime credentials are unavailable"
		}
		return reconciler.RunResult{}, reconciler.TerminalError(code, message, err)
	}
	bundleURL, err := r.bundleURL(state)
	if err != nil {
		return reconciler.RunResult{}, reconciler.TerminalError("artifact_url_invalid", "deployment bundle URL is invalid", err)
	}
	runtimeCredentialID := sha256Hex(runtimeToken)
	workload, err := Render(WorkloadInput{
		Namespace: state.Desired.Target.Namespace, OwnerID: state.UserID, DeploymentID: state.DeploymentID,
		Revision: state.Desired.Target.Revision, Generation: state.Desired.Generation,
		SchemaVersion: state.Desired.Target.SchemaVersion, ConfigHash: state.Desired.Target.ConfigHash,
		Image: state.Desired.Target.RuntimeImage, BundleURL: bundleURL,
		DeliveryTokenSecretName: deliverySecretName, DeliveryTokenID: credential.TokenID,
		RuntimeSecretName: runtimeSecretName, RuntimeCredentialID: runtimeCredentialID,
		RuntimeSecretEnvNames: credentialPlan.EnvNames, Storage: state.Storage,
	})
	if err != nil {
		return reconciler.RunResult{}, reconciler.TerminalError("workload_invalid", "deployment workload is invalid", err)
	}
	// The PVC returned by Render is the same logical object already reconciled
	// above. Keeping the renderer's complete output lets its contract remain the
	// single source of Kubernetes object shape without applying the PVC twice.
	_ = pvc

	if err := r.applySecret(ctx, state, deliverySecret); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.applySecret(ctx, state, runtimeSecret); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.applyService(ctx, state, workload.Service); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := report(deployment.DeploymentPhaseStarting, state.Observed.Ready); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.applyDeployment(ctx, state, workload.Deployment); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.waitPVCReady(ctx, state, pvc.Name, reportStorage); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.waitDeploymentReady(ctx, state, workload.Deployment.Name); err != nil {
		return reconciler.RunResult{}, err
	}
	if err := r.waitServiceEndpoint(ctx, state, workload.Service.Name); err != nil {
		return reconciler.RunResult{}, err
	}

	return reconciler.RunResult{
		Endpoint: fmt.Sprintf("http://%s.%s.svc.cluster.local", workload.Service.Name, state.Desired.Target.Namespace),
		Resources: deployment.ResourceRefs{
			Namespace:          state.Desired.Target.Namespace,
			DeploymentName:     workload.Deployment.Name,
			ServiceName:        workload.Service.Name,
			DeliverySecretName: deliverySecretName,
			RuntimeSecretName:  runtimeSecretName,
		},
	}, nil
}

func (r *Runtime) ReconcileDelete(ctx context.Context, attempt reconciler.DeleteAttempt) error {
	state := attempt.State
	if err := r.fence(ctx, state, deployment.DesiredActionDelete); err != nil {
		return err
	}
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		return reconciler.TerminalError("resource_identity_invalid", "deployment resource identity is invalid", err)
	}
	if err := r.deleteDeployment(ctx, state, name); err != nil {
		return err
	}
	if err := r.waitDeploymentDeleted(ctx, state, name); err != nil {
		return err
	}
	if err := r.deleteService(ctx, state, name); err != nil {
		return err
	}
	if err := r.waitServiceDeleted(ctx, state, name); err != nil {
		return err
	}
	for _, secretName := range []string{name + "-delivery", name + "-runtime"} {
		if err := r.deleteSecret(ctx, state, secretName); err != nil {
			return err
		}
		if err := r.waitSecretDeleted(ctx, state, secretName); err != nil {
			return err
		}
	}
	generations := []int64{state.Observed.Generation, state.Desired.Generation - 1}
	revoked := make(map[int64]struct{}, len(generations))
	for _, generation := range generations {
		if generation <= 0 {
			continue
		}
		if _, exists := revoked[generation]; exists {
			continue
		}
		revoked[generation] = struct{}{}
		if err := r.delivery.RevokeGeneration(ctx, state.UserID, state.DeploymentID, generation); err != nil {
			return reconciler.RetryableError(
				"delivery_credentials_unavailable",
				"deployment bundle credentials could not be revoked",
				err,
			)
		}
	}
	return nil
}

// ResolveAccess re-verifies the live service and generation-scoped Secret for
// a ready deployment. The public proxy never trusts a persisted endpoint and
// never returns the bearer token to its caller.
func (r *Runtime) ResolveAccess(ctx context.Context, state deployment.DeployState) (deployment.RuntimeAccess, error) {
	if state.Desired.Action != deployment.DesiredActionRun || state.Desired.Generation <= 0 ||
		state.Observed.Generation != state.Desired.Generation ||
		state.Observed.Phase != deployment.DeploymentPhaseReady || !state.Observed.Ready {
		return deployment.RuntimeAccess{}, deployment.ErrRuntimeNotReady
	}
	if err := r.fenceAccess(ctx, state); err != nil {
		return deployment.RuntimeAccess{}, err
	}
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: invalid resource identity", deployment.ErrRuntimeAccessUnavailable)
	}
	namespace := state.Desired.Target.Namespace
	if state.Observed.Resources.Namespace != namespace || state.Observed.Resources.ServiceName != name ||
		state.Observed.Resources.RuntimeSecretName != name+"-runtime" {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: observed resource identity does not match desired state", deployment.ErrRuntimeAccessUnavailable)
	}

	service, err := r.client.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: read runtime Service: %v", deployment.ErrRuntimeAccessUnavailable, err)
	}
	if err := verifyAccessObject(service, state); err != nil {
		return deployment.RuntimeAccess{}, err
	}
	if service.Spec.ClusterIP == "" || service.Spec.ClusterIP == corev1.ClusterIPNone {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: runtime Service has no cluster address", deployment.ErrRuntimeAccessUnavailable)
	}

	selector := labels.Set{discoveryv1.LabelServiceName: name}.AsSelector().String()
	slices, err := r.client.DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: read runtime endpoints: %v", deployment.ErrRuntimeAccessUnavailable, err)
	}
	readyEndpoint := false
	for _, slice := range slices.Items {
		for _, endpoint := range slice.Endpoints {
			if endpoint.Conditions.Ready != nil && *endpoint.Conditions.Ready && len(endpoint.Addresses) > 0 {
				readyEndpoint = true
				break
			}
		}
		if readyEndpoint {
			break
		}
	}
	if !readyEndpoint {
		return deployment.RuntimeAccess{}, deployment.ErrRuntimeNotReady
	}

	secret, err := r.client.CoreV1().Secrets(namespace).Get(ctx, name+"-runtime", metav1.GetOptions{})
	if err != nil {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: read runtime credential: %v", deployment.ErrRuntimeAccessUnavailable, err)
	}
	if err := verifyAccessObject(secret, state); err != nil {
		return deployment.RuntimeAccess{}, err
	}
	token := string(secret.Data[deployment.RuntimeAPITokenEnvName])
	if err := deployment.ValidateRuntimeAPIToken(token); err != nil {
		return deployment.RuntimeAccess{}, fmt.Errorf("%w: runtime credential is invalid", deployment.ErrRuntimeAccessUnavailable)
	}
	if err := r.fenceAccess(ctx, state); err != nil {
		return deployment.RuntimeAccess{}, err
	}
	return deployment.RuntimeAccess{
		BaseURL:     "http://" + name + "." + namespace + ".svc.cluster.local",
		BearerToken: token,
	}, nil
}

func (r *Runtime) fenceAccess(ctx context.Context, expected deployment.DeployState) error {
	current, err := r.states.Get(ctx, expected.UserID, expected.DeploymentID)
	if err != nil {
		return fmt.Errorf("%w: deployment state could not be verified", deployment.ErrRuntimeAccessUnavailable)
	}
	if current == nil || current.UserID != expected.UserID || current.DeploymentID != expected.DeploymentID ||
		current.Desired.Generation != expected.Desired.Generation || current.Desired.Action != deployment.DesiredActionRun ||
		current.Desired.Target != expected.Desired.Target || current.Observed.Generation != expected.Desired.Generation ||
		current.Observed.Phase != deployment.DeploymentPhaseReady || !current.Observed.Ready {
		return deployment.ErrRuntimeNotReady
	}
	return nil
}

func verifyAccessObject(object metav1.Object, state deployment.DeployState) error {
	if object == nil || !isManagedFor(object, state.UserID, state.DeploymentID) ||
		object.GetAnnotations()[generationAnnotation] != strconv.FormatInt(state.Desired.Generation, 10) ||
		object.GetAnnotations()[revisionAnnotation] != strconv.Itoa(state.Desired.Target.Revision) {
		return fmt.Errorf("%w: runtime resource ownership or generation does not match", deployment.ErrRuntimeAccessUnavailable)
	}
	return nil
}

func (r *Runtime) fence(ctx context.Context, expected deployment.DeployState, action deployment.DesiredAction) error {
	current, err := r.states.Get(ctx, expected.UserID, expected.DeploymentID)
	if err != nil {
		return reconciler.RetryableError("deployment_state_unavailable", "deployment state could not be verified", err)
	}
	if current == nil || current.UserID != expected.UserID || current.DeploymentID != expected.DeploymentID ||
		current.Desired.Generation != expected.Desired.Generation || current.Desired.Action != action ||
		current.Desired.Target != expected.Desired.Target {
		return reconciler.ErrClaimLost
	}
	return nil
}

func (r *Runtime) bundleURL(state deployment.DeployState) (string, error) {
	if strings.ContainsAny(state.DeploymentID, "/?#") {
		return "", errors.New("deployment ID contains URL path delimiters")
	}
	joined, err := url.JoinPath(
		r.artifactBaseURL.String(),
		"internal", "v1", "deployments", state.DeploymentID,
		"generations", strconv.FormatInt(state.Desired.Generation, 10),
		"revisions", strconv.Itoa(state.Desired.Target.Revision), "bundle",
	)
	if err != nil {
		return "", err
	}
	return joined, nil
}

func (r *Runtime) ensurePVC(
	ctx context.Context,
	state deployment.DeployState,
	reportStorage reconciler.StorageReporter,
) (*corev1.PersistentVolumeClaim, error) {
	desiredWorkload, err := Render(WorkloadInput{
		Namespace: state.Desired.Target.Namespace, OwnerID: state.UserID, DeploymentID: state.DeploymentID,
		Revision: state.Desired.Target.Revision, Generation: state.Desired.Generation,
		SchemaVersion: state.Desired.Target.SchemaVersion, ConfigHash: state.Desired.Target.ConfigHash,
		Image: state.Desired.Target.RuntimeImage, BundleURL: "https://placeholder.invalid/bundle",
		DeliveryTokenSecretName: "placeholder-delivery", DeliveryTokenID: "placeholder-token",
		RuntimeSecretName: "placeholder-runtime", RuntimeCredentialID: "placeholder-runtime-token",
		RuntimeSecretEnvNames: []string{"PLACEHOLDER_API_KEY"}, Storage: state.Storage,
	})
	if err != nil {
		return nil, reconciler.TerminalError("storage_plan_invalid", "deployment storage plan is invalid", err)
	}
	desired := desiredWorkload.PersistentVolumeClaim
	pvcs := r.client.CoreV1().PersistentVolumeClaims(desired.Namespace)
	current, err := pvcs.Get(ctx, desired.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		if state.Storage.Phase == deployment.StoragePhaseReady || state.Storage.Phase == deployment.StoragePhaseRetained {
			if reportErr := reportStorage.Missing(); reportErr != nil {
				return nil, reportErr
			}
			return nil, reconciler.TerminalError(
				"storage_missing",
				"deployment retained storage is missing",
				err,
			)
		}
		if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
			return nil, err
		}
		current, err = pvcs.Create(ctx, desired, metav1.CreateOptions{})
	}
	if err != nil {
		return nil, kubeFailure("reconcile persistent volume claim", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return nil, err
	}
	if err := verifyPVCContract(current, state.Storage, false); err != nil {
		return nil, err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
		return nil, err
	}
	desired.ResourceVersion = current.ResourceVersion
	desired.UID = current.UID
	desired.Spec = current.Spec
	desired.Status = current.Status
	current, err = pvcs.Update(ctx, desired, metav1.UpdateOptions{})
	if err != nil {
		return nil, kubeFailure("update persistent volume claim metadata", err)
	}

	return current, nil
}

// waitPVCReady runs after the workload has been created. That ordering supports
// StorageClasses using WaitForFirstConsumer, which cannot bind a new PVC until
// a schedulable pod references it.
func (r *Runtime) waitPVCReady(
	ctx context.Context,
	state deployment.DeployState,
	name string,
	reportStorage reconciler.StorageReporter,
) error {
	pvcs := r.client.CoreV1().PersistentVolumeClaims(state.Desired.Target.Namespace)
	var bound *corev1.PersistentVolumeClaim
	err := wait.PollUntilContextTimeout(ctx, r.pollInterval, r.readyTimeout, true, func(pollCtx context.Context) (bool, error) {
		observed, getErr := pvcs.Get(pollCtx, name, metav1.GetOptions{})
		if getErr != nil {
			if apierrors.IsNotFound(getErr) && (state.Storage.Phase == deployment.StoragePhaseReady || state.Storage.Phase == deployment.StoragePhaseRetained) {
				if reportErr := reportStorage.Missing(); reportErr != nil {
					return false, reportErr
				}
				return false, reconciler.TerminalError("storage_missing", "deployment retained storage is missing", getErr)
			}
			return false, kubeFailure("observe persistent volume claim", getErr)
		}
		if observed.DeletionTimestamp != nil {
			return false, reconciler.TerminalError("storage_conflict", "deployment storage is being deleted", nil)
		}
		if observed.Status.Phase != corev1.ClaimBound {
			return false, nil
		}
		if verifyErr := verifyPVCContract(observed, state.Storage, true); verifyErr != nil {
			return false, verifyErr
		}
		bound = observed
		return true, nil
	})
	if err != nil {
		var typed *reconciler.Error
		if errors.As(err, &typed) || errors.Is(err, reconciler.ErrClaimLost) {
			return err
		}
		return reconciler.RetryableError("storage_not_ready", "deployment storage did not become ready", err)
	}
	if err := reportStorage.Ready(storageBinding(bound, state.Storage)); err != nil {
		return err
	}
	return nil
}

func verifyPVCContract(pvc *corev1.PersistentVolumeClaim, storage deployment.StorageState, requireBound bool) error {
	if pvc == nil || pvc.Namespace != storage.Namespace || pvc.Name != storage.PVCName ||
		pvc.Annotations["agentflow.dev/storage-id"] != storage.StorageID {
		return reconciler.TerminalError("storage_identity_conflict", "observed persistent storage does not match retained storage", nil)
	}
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		return reconciler.TerminalError("storage_contract_conflict", "persistent storage access mode is incompatible", nil)
	}
	if pvc.Spec.VolumeMode != nil && *pvc.Spec.VolumeMode != corev1.PersistentVolumeFilesystem {
		return reconciler.TerminalError("storage_contract_conflict", "persistent storage volume mode is incompatible", nil)
	}
	requested := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
	if requested.Value() < deployment.DefaultStorageCapacityBytes {
		return reconciler.TerminalError("storage_contract_conflict", "persistent storage capacity is smaller than required", nil)
	}
	if !requireBound {
		return nil
	}
	if pvc.UID == "" || pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName == "" {
		return reconciler.TerminalError("storage_binding_invalid", "persistent storage binding is incomplete", nil)
	}
	capacity := pvc.Status.Capacity[corev1.ResourceStorage]
	if capacity.Value() < deployment.DefaultStorageCapacityBytes {
		return reconciler.TerminalError("storage_contract_conflict", "persistent storage capacity is smaller than required", nil)
	}
	if storage.PVCUID != "" && storage.PVCUID != string(pvc.UID) {
		return reconciler.TerminalError("storage_identity_conflict", "observed persistent storage does not match retained storage", nil)
	}
	if storage.StorageClassName != "" && storage.StorageClassName != *pvc.Spec.StorageClassName {
		return reconciler.TerminalError("storage_identity_conflict", "observed persistent storage does not match retained storage", nil)
	}
	return nil
}

func storageBinding(pvc *corev1.PersistentVolumeClaim, storage deployment.StorageState) deployment.StorageBindingObservation {
	capacity := pvc.Status.Capacity[corev1.ResourceStorage]
	return deployment.StorageBindingObservation{
		StorageID: storage.StorageID, Namespace: pvc.Namespace, PVCName: pvc.Name,
		PVCUID: string(pvc.UID), StorageClassName: *pvc.Spec.StorageClassName,
		CapacityBytes: capacity.Value(), AccessMode: deployment.StorageAccessModeReadWriteOnce,
		VolumeMode: deployment.StorageVolumeModeFilesystem,
	}
}

func (r *Runtime) applySecret(ctx context.Context, state deployment.DeployState, desired *corev1.Secret) error {
	secrets := r.client.CoreV1().Secrets(desired.Namespace)
	current, err := secrets.Get(ctx, desired.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
			return err
		}
		_, err = secrets.Create(ctx, desired, metav1.CreateOptions{})
		return mutationFailure("create Secret", err)
	}
	if err != nil {
		return kubeFailure("read Secret", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
		return err
	}
	desired.ResourceVersion = current.ResourceVersion
	desired.UID = current.UID
	_, err = secrets.Update(ctx, desired, metav1.UpdateOptions{})
	return mutationFailure("update Secret", err)
}

func (r *Runtime) applyService(ctx context.Context, state deployment.DeployState, desired *corev1.Service) error {
	services := r.client.CoreV1().Services(desired.Namespace)
	current, err := services.Get(ctx, desired.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
			return err
		}
		_, err = services.Create(ctx, desired, metav1.CreateOptions{})
		return mutationFailure("create Service", err)
	}
	if err != nil {
		return kubeFailure("read Service", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
		return err
	}
	desired.ResourceVersion = current.ResourceVersion
	desired.UID = current.UID
	desired.Spec.ClusterIP = current.Spec.ClusterIP
	desired.Spec.ClusterIPs = append([]string(nil), current.Spec.ClusterIPs...)
	desired.Spec.IPFamilies = append([]corev1.IPFamily(nil), current.Spec.IPFamilies...)
	desired.Spec.IPFamilyPolicy = current.Spec.IPFamilyPolicy
	desired.Spec.InternalTrafficPolicy = current.Spec.InternalTrafficPolicy
	desired.Status = current.Status
	_, err = services.Update(ctx, desired, metav1.UpdateOptions{})
	return mutationFailure("update Service", err)
}

func (r *Runtime) applyDeployment(ctx context.Context, state deployment.DeployState, desired *appsv1.Deployment) error {
	deployments := r.client.AppsV1().Deployments(desired.Namespace)
	current, err := deployments.Get(ctx, desired.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
			return err
		}
		_, err = deployments.Create(ctx, desired, metav1.CreateOptions{})
		return mutationFailure("create Deployment", err)
	}
	if err != nil {
		return kubeFailure("read Deployment", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionRun); err != nil {
		return err
	}
	desired.ResourceVersion = current.ResourceVersion
	desired.UID = current.UID
	desired.Status = current.Status
	_, err = deployments.Update(ctx, desired, metav1.UpdateOptions{})
	return mutationFailure("update Deployment", err)
}

func (r *Runtime) waitDeploymentReady(ctx context.Context, state deployment.DeployState, name string) error {
	err := wait.PollUntilContextTimeout(ctx, r.pollInterval, r.readyTimeout, true, func(pollCtx context.Context) (bool, error) {
		observed, err := r.client.AppsV1().Deployments(state.Desired.Target.Namespace).Get(pollCtx, name, metav1.GetOptions{})
		if err != nil {
			return false, kubeFailure("observe Deployment", err)
		}
		if err := verifyOwnedObject(observed, state); err != nil {
			return false, err
		}
		if observed.Status.ObservedGeneration < observed.Generation || observed.Status.ReadyReplicas != 1 ||
			observed.Status.AvailableReplicas != 1 || observed.Status.UnavailableReplicas != 0 {
			return false, nil
		}
		return true, nil
	})
	if err == nil {
		return nil
	}
	var typed *reconciler.Error
	if errors.As(err, &typed) || errors.Is(err, reconciler.ErrClaimLost) {
		return err
	}
	return reconciler.RetryableError("workload_not_ready", "deployment workload did not become ready", err)
}

func (r *Runtime) waitServiceEndpoint(ctx context.Context, state deployment.DeployState, serviceName string) error {
	selector := labels.Set{discoveryv1.LabelServiceName: serviceName}.AsSelector().String()
	err := wait.PollUntilContextTimeout(ctx, r.pollInterval, r.readyTimeout, true, func(pollCtx context.Context) (bool, error) {
		slices, err := r.client.DiscoveryV1().EndpointSlices(state.Desired.Target.Namespace).List(
			pollCtx,
			metav1.ListOptions{LabelSelector: selector},
		)
		if err != nil {
			return false, kubeFailure("observe Service endpoints", err)
		}
		for _, slice := range slices.Items {
			for _, endpoint := range slice.Endpoints {
				if endpoint.Conditions.Ready != nil && *endpoint.Conditions.Ready && len(endpoint.Addresses) > 0 {
					return true, nil
				}
			}
		}
		return false, nil
	})
	if err == nil {
		return nil
	}
	var typed *reconciler.Error
	if errors.As(err, &typed) || errors.Is(err, reconciler.ErrClaimLost) {
		return err
	}
	return reconciler.RetryableError("service_not_ready", "deployment Service has no ready endpoint", err)
}

func (r *Runtime) deleteDeployment(ctx context.Context, state deployment.DeployState, name string) error {
	deployments := r.client.AppsV1().Deployments(state.Desired.Target.Namespace)
	current, err := deployments.Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return kubeFailure("read Deployment for deletion", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionDelete); err != nil {
		return err
	}
	propagation := metav1.DeletePropagationForeground
	err = deployments.Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &propagation})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return mutationFailure("delete Deployment", err)
}

func (r *Runtime) waitDeploymentDeleted(ctx context.Context, state deployment.DeployState, name string) error {
	err := wait.PollUntilContextTimeout(ctx, r.pollInterval, r.readyTimeout, true, func(pollCtx context.Context) (bool, error) {
		_, err := r.client.AppsV1().Deployments(state.Desired.Target.Namespace).Get(pollCtx, name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return true, nil
		}
		if err != nil {
			return false, kubeFailure("observe Deployment deletion", err)
		}
		return false, nil
	})
	if err == nil {
		return nil
	}
	var typed *reconciler.Error
	if errors.As(err, &typed) || errors.Is(err, reconciler.ErrClaimLost) {
		return err
	}
	return reconciler.RetryableError("workload_delete_pending", "deployment workload deletion is still pending", err)
}

func (r *Runtime) deleteService(ctx context.Context, state deployment.DeployState, name string) error {
	services := r.client.CoreV1().Services(state.Desired.Target.Namespace)
	current, err := services.Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return kubeFailure("read Service for deletion", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionDelete); err != nil {
		return err
	}
	err = services.Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return mutationFailure("delete Service", err)
}

func (r *Runtime) deleteSecret(ctx context.Context, state deployment.DeployState, name string) error {
	secrets := r.client.CoreV1().Secrets(state.Desired.Target.Namespace)
	current, err := secrets.Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return kubeFailure("read Secret for deletion", err)
	}
	if err := verifyOwnedObject(current, state); err != nil {
		return err
	}
	if err := r.fence(ctx, state, deployment.DesiredActionDelete); err != nil {
		return err
	}
	err = secrets.Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return mutationFailure("delete Secret", err)
}

func (r *Runtime) waitServiceDeleted(ctx context.Context, state deployment.DeployState, name string) error {
	return r.waitDeleted(ctx, "Service", func(pollCtx context.Context) error {
		_, err := r.client.CoreV1().Services(state.Desired.Target.Namespace).Get(pollCtx, name, metav1.GetOptions{})
		return err
	})
}

func (r *Runtime) waitSecretDeleted(ctx context.Context, state deployment.DeployState, name string) error {
	return r.waitDeleted(ctx, "Secret", func(pollCtx context.Context) error {
		_, err := r.client.CoreV1().Secrets(state.Desired.Target.Namespace).Get(pollCtx, name, metav1.GetOptions{})
		return err
	})
}

func (r *Runtime) waitDeleted(ctx context.Context, kind string, get func(context.Context) error) error {
	err := wait.PollUntilContextTimeout(ctx, r.pollInterval, r.readyTimeout, true, func(pollCtx context.Context) (bool, error) {
		err := get(pollCtx)
		if apierrors.IsNotFound(err) {
			return true, nil
		}
		if err != nil {
			return false, kubeFailure("observe "+kind+" deletion", err)
		}
		return false, nil
	})
	if err == nil {
		return nil
	}
	var typed *reconciler.Error
	if errors.As(err, &typed) || errors.Is(err, reconciler.ErrClaimLost) {
		return err
	}
	return reconciler.RetryableError("resource_delete_pending", "deployment resource deletion is still pending", err)
}

func verifyOwnedObject(object metav1.Object, state deployment.DeployState) error {
	if object == nil || !isManagedFor(object, state.UserID, state.DeploymentID) {
		return reconciler.TerminalError("resource_conflict", "a Kubernetes resource name is already owned by another workload", nil)
	}
	if rawGeneration := object.GetAnnotations()[generationAnnotation]; rawGeneration != "" {
		generation, err := strconv.ParseInt(rawGeneration, 10, 64)
		if err != nil {
			return reconciler.TerminalError("resource_conflict", "a Kubernetes resource has invalid AgentFlow ownership metadata", err)
		}
		if generation > state.Desired.Generation {
			return reconciler.ErrClaimLost
		}
	}
	return nil
}

func mutationFailure(operation string, err error) error {
	if err == nil {
		return nil
	}
	return kubeFailure(operation, err)
}

func kubeFailure(operation string, err error) error {
	if err == nil {
		return nil
	}
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) || apierrors.IsInvalid(err) {
		return reconciler.TerminalError("kubernetes_access_denied", "Kubernetes rejected the deployment operation", fmt.Errorf("%s: %w", operation, err))
	}
	return reconciler.RetryableError("kubernetes_unavailable", "Kubernetes is temporarily unavailable", fmt.Errorf("%s: %w", operation, err))
}

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
