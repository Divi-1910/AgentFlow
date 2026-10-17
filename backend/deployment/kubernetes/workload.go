package kubernetes

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	deploymentmodel "backend/deployment"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/validation"
)

const (
	runtimePort       = 8080
	runtimeUID  int64 = 10001
	runtimeGID  int64 = 10001

	bundlePath        = "/var/run/agentflow/bundle/bundle.json"
	deliveryTokenPath = "/var/run/secrets/agentflow-delivery/token"
	runtimeDataPath   = "/var/lib/agentflow"
)

var (
	configHashRE      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	imageDigestRE     = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)
	envNameRE         = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	nonDNSLabelCharRE = regexp.MustCompile(`[^a-z0-9]+`)
)

var reservedRuntimeEnv = map[string]struct{}{
	"GODEBUG": {}, "GOMEMLIMIT": {}, "GOMAXPROCS": {}, "GOTRACEBACK": {},
	"HOME": {}, "HOSTNAME": {}, "HTTP_PROXY": {}, "HTTPS_PROXY": {},
	"NO_PROXY": {}, "PATH": {}, "RG_PATH": {}, "RUNTIME_API_TOKEN": {},
	"RUNTIME_AUTH_MODE": {}, "SSL_CERT_DIR": {}, "SSL_CERT_FILE": {},
}

type WorkloadInput struct {
	Namespace               string
	OwnerID                 string
	DeploymentID            string
	Revision                int
	Generation              int64
	SchemaVersion           int
	ConfigHash              string
	Image                   string
	BundleURL               string
	DeliveryTokenSecretName string
	DeliveryTokenID         string
	RuntimeSecretName       string
	RuntimeCredentialID     string
	RuntimeSecretEnvNames   []string
	Storage                 deploymentmodel.StorageState
}

type Workload struct {
	PersistentVolumeClaim *corev1.PersistentVolumeClaim
	Deployment            *appsv1.Deployment
	Service               *corev1.Service
}

func Render(input WorkloadInput) (*Workload, error) {
	name, err := StableResourceName(input.OwnerID, input.DeploymentID)
	if err != nil {
		return nil, err
	}
	if err := validateInput(input); err != nil {
		return nil, err
	}

	managedLabels, managedAnnotations := managedMetadata(input.OwnerID, input.DeploymentID, input.Generation, input.Revision)
	selector := map[string]string{
		"app.kubernetes.io/name":     "agentflow-runtime",
		"app.kubernetes.io/instance": name,
	}
	podLabels := mergeStringMap(selector, managedLabels)
	podLabels["agentflow.dev/config-hash"] = input.ConfigHash[:12]
	podLabels["agentflow.dev/revision"] = strconv.Itoa(input.Revision)
	podAnnotations := mergeStringMap(managedAnnotations, map[string]string{
		"agentflow.dev/config-hash":    input.ConfigHash,
		"agentflow.dev/generation":     strconv.FormatInt(input.Generation, 10),
		"agentflow.dev/revision":       strconv.Itoa(input.Revision),
		"agentflow.dev/schema-version": strconv.Itoa(input.SchemaVersion),
		"agentflow.dev/storage-id":     input.Storage.StorageID,
		deliveryTokenIDAnnotation:      input.DeliveryTokenID,
		runtimeCredentialAnnotation:    input.RuntimeCredentialID,
	})

	persistentVolumeClaim := renderPersistentVolumeClaim(input, managedLabels, managedAnnotations)
	deployment := renderDeployment(input, name, selector, podLabels, podAnnotations, managedLabels, managedAnnotations)
	service := renderService(input.Namespace, name, selector, managedLabels, managedAnnotations)
	return &Workload{
		PersistentVolumeClaim: persistentVolumeClaim,
		Deployment:            deployment,
		Service:               service,
	}, nil
}

func StableResourceName(ownerID, deploymentID string) (string, error) {
	if strings.TrimSpace(ownerID) == "" || strings.TrimSpace(deploymentID) == "" {
		return "", errors.New("kubernetes workload: owner and deployment IDs are required")
	}
	base := strings.Trim(nonDNSLabelCharRE.ReplaceAllString(strings.ToLower(deploymentID), "-"), "-")
	if base == "" {
		base = "deployment"
	}
	digest := sha256.Sum256([]byte(ownerID + "\x00" + deploymentID))
	suffix := "-" + hex.EncodeToString(digest[:10])
	const prefix = "af-"
	maxBase := 63 - len(prefix) - len(suffix)
	if len(base) > maxBase {
		base = strings.TrimRight(base[:maxBase], "-")
	}
	if base == "" {
		base = "deployment"
	}
	return prefix + base + suffix, nil
}

func validateInput(input WorkloadInput) error {
	if errs := validation.IsDNS1123Label(input.Namespace); len(errs) != 0 {
		return fmt.Errorf("kubernetes workload: invalid namespace: %s", strings.Join(errs, "; "))
	}
	if input.Revision <= 0 || input.Generation <= 0 || input.SchemaVersion <= 0 {
		return errors.New("kubernetes workload: revision, generation, and schema version must be positive")
	}
	if !configHashRE.MatchString(input.ConfigHash) {
		return errors.New("kubernetes workload: config hash must be 64 lowercase hexadecimal characters")
	}
	if strings.TrimSpace(input.DeliveryTokenID) == "" {
		return errors.New("kubernetes workload: delivery token ID is required")
	}
	if strings.TrimSpace(input.RuntimeCredentialID) == "" {
		return errors.New("kubernetes workload: runtime credential ID is required")
	}
	if !validDigestPinnedImage(input.Image) {
		return errors.New("kubernetes workload: runtime image must be pinned by a lowercase sha256 digest")
	}
	parsedURL, err := url.ParseRequestURI(input.BundleURL)
	if err != nil || parsedURL.Scheme != "https" || parsedURL.Host == "" || parsedURL.User != nil || parsedURL.Fragment != "" || parsedURL.RawQuery != "" {
		return errors.New("kubernetes workload: bundle URL must be an absolute HTTPS URL without user information, query parameters, or a fragment")
	}
	for field, value := range map[string]string{
		"delivery token Secret": input.DeliveryTokenSecretName,
		"runtime Secret":        input.RuntimeSecretName,
	} {
		if errs := validation.IsDNS1123Subdomain(value); len(errs) != 0 {
			return fmt.Errorf("kubernetes workload: invalid %s name: %s", field, strings.Join(errs, "; "))
		}
	}
	if err := validateRuntimeSecretEnvNames(input.RuntimeSecretEnvNames); err != nil {
		return fmt.Errorf("kubernetes workload: %w", err)
	}
	if err := validateStorage(input); err != nil {
		return err
	}
	return nil
}

func validateStorage(input WorkloadInput) error {
	if err := deploymentmodel.ValidateStoragePlan(input.Storage.StoragePlan); err != nil {
		return fmt.Errorf("kubernetes workload: invalid storage plan: %w", err)
	}
	expected, err := deploymentmodel.NewStoragePlan(input.OwnerID, input.DeploymentID, input.Namespace)
	if err != nil {
		return fmt.Errorf("kubernetes workload: derive storage plan: %w", err)
	}
	if input.Storage.StoragePlan != expected {
		return errors.New("kubernetes workload: storage plan does not belong to this owner, deployment, and namespace")
	}
	if input.Storage.LegacyPVCName != "" || input.Storage.LegacyPVCNamespace != "" {
		return errors.New("kubernetes workload: legacy storage requires explicit migration")
	}

	switch input.Storage.Phase {
	case deploymentmodel.StoragePhasePlanned:
		if input.Storage.PVCUID != "" || input.Storage.StorageClassName != "" || input.Storage.CapacityBytes != 0 {
			return errors.New("kubernetes workload: planned storage cannot contain a verified binding")
		}
		return nil
	case deploymentmodel.StoragePhaseReady, deploymentmodel.StoragePhaseRetained:
		binding := deploymentmodel.StorageBindingObservation{
			StorageID:        input.Storage.StorageID,
			Namespace:        input.Storage.Namespace,
			PVCName:          input.Storage.PVCName,
			PVCUID:           input.Storage.PVCUID,
			StorageClassName: input.Storage.StorageClassName,
			CapacityBytes:    input.Storage.CapacityBytes,
			AccessMode:       input.Storage.AccessMode,
			VolumeMode:       input.Storage.VolumeMode,
		}
		if err := deploymentmodel.ValidateStorageBinding(binding); err != nil {
			return fmt.Errorf("kubernetes workload: invalid verified storage binding: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("kubernetes workload: storage phase %q is not deployable", input.Storage.Phase)
	}
}

func validateRuntimeSecretEnvNames(names []string) error {
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if !envNameRE.MatchString(name) {
			return fmt.Errorf("invalid runtime secret environment name %q", name)
		}
		if _, reserved := reservedRuntimeEnv[name]; reserved || strings.HasPrefix(name, "KUBERNETES_") || strings.HasPrefix(name, "AGENTFLOW_") {
			return fmt.Errorf("runtime secret environment name %q is reserved", name)
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("duplicate runtime secret environment name %q", name)
		}
		seen[name] = struct{}{}
	}
	return nil
}

func renderDeployment(input WorkloadInput, name string, selector, podLabels, podAnnotations, managedLabels, managedAnnotations map[string]string) *appsv1.Deployment {
	replicas := int32(1)
	revisionHistoryLimit := int32(2)
	progressDeadlineSeconds := int32(600)
	terminationGracePeriodSeconds := int64(60)
	automountServiceAccountToken := false
	runAsNonRoot := true
	allowPrivilegeEscalation := false
	readOnlyRootFilesystem := true
	defaultMode := int32(0o440)
	fsGroupChangePolicy := corev1.FSGroupChangeOnRootMismatch
	bundleSizeLimit := resource.MustParse("32Mi")
	tmpSizeLimit := resource.MustParse("256Mi")

	return &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: input.Namespace,
			Labels: mergeStringMap(selector, managedLabels), Annotations: cloneMap(managedAnnotations),
		},
		Spec: appsv1.DeploymentSpec{
			Replicas:                &replicas,
			Strategy:                appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			RevisionHistoryLimit:    &revisionHistoryLimit,
			ProgressDeadlineSeconds: &progressDeadlineSeconds,
			Selector:                &metav1.LabelSelector{MatchLabels: cloneMap(selector)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: podLabels, Annotations: podAnnotations},
				Spec: corev1.PodSpec{
					AutomountServiceAccountToken:  &automountServiceAccountToken,
					EnableServiceLinks:            boolPtr(false),
					TerminationGracePeriodSeconds: &terminationGracePeriodSeconds,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: &runAsNonRoot, RunAsUser: int64Ptr(runtimeUID), RunAsGroup: int64Ptr(runtimeGID),
						FSGroup: int64Ptr(runtimeGID), FSGroupChangePolicy: &fsGroupChangePolicy,
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					InitContainers: []corev1.Container{{
						Name: "materialize-bundle", Image: input.Image, ImagePullPolicy: corev1.PullIfNotPresent,
						Args: []string{
							"materialize-bundle", "--url", input.BundleURL,
							"--token-file", deliveryTokenPath,
							"--expected-config-hash", input.ConfigHash,
							"--output", bundlePath,
						},
						Resources:       initResources(),
						SecurityContext: containerSecurityContext(allowPrivilegeEscalation, readOnlyRootFilesystem),
						VolumeMounts: []corev1.VolumeMount{
							{Name: "bundle", MountPath: path.Dir(bundlePath)},
							{Name: "delivery-token", MountPath: path.Dir(deliveryTokenPath), ReadOnly: true},
						},
					}},
					Containers: []corev1.Container{{
						Name: "runtime", Image: input.Image, ImagePullPolicy: corev1.PullIfNotPresent,
						Args:            runtimeArgs(input),
						Ports:           []corev1.ContainerPort{{Name: "http", ContainerPort: runtimePort, Protocol: corev1.ProtocolTCP}},
						Env:             runtimeEnv(input),
						Resources:       runtimeResources(),
						SecurityContext: containerSecurityContext(allowPrivilegeEscalation, readOnlyRootFilesystem),
						VolumeMounts: []corev1.VolumeMount{
							{Name: "bundle", MountPath: path.Dir(bundlePath), ReadOnly: true},
							{Name: "state", MountPath: runtimeDataPath},
							{Name: "tmp", MountPath: "/tmp"},
						},
						StartupProbe:             httpProbe("/readyz", 5, 60),
						ReadinessProbe:           httpProbe("/readyz", 5, 3),
						LivenessProbe:            httpProbe("/healthz", 10, 3),
						TerminationMessagePolicy: corev1.TerminationMessageFallbackToLogsOnError,
					}},
					Volumes: []corev1.Volume{
						{Name: "bundle", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &bundleSizeLimit}}},
						{Name: "delivery-token", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
							SecretName: input.DeliveryTokenSecretName, DefaultMode: &defaultMode,
							Items: []corev1.KeyToPath{{Key: "token", Path: "token"}},
						}}},
						{Name: "state", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: input.Storage.PVCName}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &tmpSizeLimit}}},
					},
				},
			},
		},
	}
}

func renderPersistentVolumeClaim(input WorkloadInput, managedLabels, managedAnnotations map[string]string) *corev1.PersistentVolumeClaim {
	storage := input.Storage
	volumeMode := corev1.PersistentVolumeFilesystem
	requestedCapacity := *resource.NewQuantity(storage.RequestedCapacityBytes, resource.BinarySI)
	return &corev1.PersistentVolumeClaim{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "PersistentVolumeClaim"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      storage.PVCName,
			Namespace: storage.Namespace,
			Labels: mergeStringMap(managedLabels, map[string]string{
				"app.kubernetes.io/managed-by": "agentflow",
				"app.kubernetes.io/name":       "agentflow-runtime-storage",
				"agentflow.dev/storage-id":     storage.StorageID[:12],
			}),
			Annotations: mergeStringMap(managedAnnotations, map[string]string{
				"agentflow.dev/storage-id": storage.StorageID,
			}),
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: requestedCapacity},
			},
			VolumeMode: &volumeMode,
		},
	}
}

func renderService(namespace, name string, selector, managedLabels, managedAnnotations map[string]string) *corev1.Service {
	return &corev1.Service{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: namespace,
			Labels: mergeStringMap(selector, managedLabels), Annotations: cloneMap(managedAnnotations),
		},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: cloneMap(selector),
			Ports:    []corev1.ServicePort{{Name: "http", Port: 80, TargetPort: intstr.FromString("http"), Protocol: corev1.ProtocolTCP}},
		},
	}
}

func runtimeEnv(input WorkloadInput) []corev1.EnvVar {
	env := []corev1.EnvVar{
		{Name: "RUNTIME_AUTH_MODE", Value: "bearer"},
		secretEnv("RUNTIME_API_TOKEN", input.RuntimeSecretName),
	}
	names := append([]string(nil), input.RuntimeSecretEnvNames...)
	sort.Strings(names)
	for _, name := range names {
		env = append(env, secretEnv(name, input.RuntimeSecretName))
	}
	return env
}

func runtimeArgs(input WorkloadInput) []string {
	return []string{
		"serve",
		"--config", bundlePath,
		"--data", runtimeDataPath,
		"--listen", ":8080",
		"--managed-storage",
		"--storage-id", input.Storage.StorageID,
		"--deployment-id", input.DeploymentID,
		"--revision", strconv.Itoa(input.Revision),
		"--generation", strconv.FormatInt(input.Generation, 10),
		"--expected-config-hash", input.ConfigHash,
	}
}

func secretEnv(name, secretName string) corev1.EnvVar {
	return corev1.EnvVar{
		Name: name,
		ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: secretName}, Key: name,
		}},
	}
}

func containerSecurityContext(allowPrivilegeEscalation, readOnlyRootFilesystem bool) *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: &allowPrivilegeEscalation,
		ReadOnlyRootFilesystem:   &readOnlyRootFilesystem,
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}
}

func runtimeResources() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("512Mi")},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("1Gi")},
	}
}

func initResources() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("16Mi")},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("64Mi")},
	}
}

func httpProbe(path string, periodSeconds, failureThreshold int32) *corev1.Probe {
	return &corev1.Probe{
		ProbeHandler:  corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: path, Port: intstr.FromString("http"), Scheme: corev1.URISchemeHTTP}},
		PeriodSeconds: periodSeconds, TimeoutSeconds: 1, FailureThreshold: failureThreshold,
	}
}

func validDigestPinnedImage(image string) bool {
	digestAt := strings.LastIndex(image, "@sha256:")
	if digestAt <= 0 || strings.Count(image, "@") != 1 || !imageDigestRE.MatchString(image) {
		return false
	}
	return strings.IndexFunc(image, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) == -1
}

func cloneMap(input map[string]string) map[string]string {
	copy := make(map[string]string, len(input))
	for key, value := range input {
		copy[key] = value
	}
	return copy
}

func boolPtr(value bool) *bool    { return &value }
func int64Ptr(value int64) *int64 { return &value }
