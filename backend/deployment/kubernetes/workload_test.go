package kubernetes_test

import (
	"reflect"
	"strings"
	"testing"

	deploymentmodel "backend/deployment"
	"backend/deployment/kubernetes"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

func TestRenderProducesSinglePodRecreateWorkload(t *testing.T) {
	t.Parallel()
	input := validWorkloadInput(t)
	workload, err := kubernetes.Render(input)
	if err != nil {
		t.Fatal(err)
	}
	deployment := workload.Deployment
	service := workload.Service
	persistentVolumeClaim := workload.PersistentVolumeClaim
	if persistentVolumeClaim == nil {
		t.Fatal("persistent volume claim was not rendered")
	}
	if persistentVolumeClaim.Name != input.Storage.PVCName || persistentVolumeClaim.Namespace != input.Storage.Namespace {
		t.Fatalf("PVC identity = %s/%s", persistentVolumeClaim.Namespace, persistentVolumeClaim.Name)
	}
	if len(persistentVolumeClaim.OwnerReferences) != 0 {
		t.Fatalf("PVC owner references = %+v, want none", persistentVolumeClaim.OwnerReferences)
	}
	if persistentVolumeClaim.Spec.StorageClassName != nil {
		t.Fatalf("PVC storage class = %q, want cluster default (nil)", *persistentVolumeClaim.Spec.StorageClassName)
	}
	if len(persistentVolumeClaim.Spec.AccessModes) != 1 || persistentVolumeClaim.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		t.Fatalf("PVC access modes = %v, want ReadWriteOnce", persistentVolumeClaim.Spec.AccessModes)
	}
	if persistentVolumeClaim.Spec.VolumeMode == nil || *persistentVolumeClaim.Spec.VolumeMode != corev1.PersistentVolumeFilesystem {
		t.Fatalf("PVC volume mode = %v, want Filesystem", persistentVolumeClaim.Spec.VolumeMode)
	}
	requestedStorage := persistentVolumeClaim.Spec.Resources.Requests[corev1.ResourceStorage]
	if requestedStorage.Value() != deploymentmodel.DefaultStorageCapacityBytes {
		t.Fatalf("PVC requested storage = %s (%d bytes), want 5 GiB", requestedStorage.String(), requestedStorage.Value())
	}
	if got := persistentVolumeClaim.Annotations["agentflow.dev/storage-id"]; got != input.Storage.StorageID {
		t.Fatalf("PVC storage-id annotation = %q", got)
	}
	if deployment.Name == "" || deployment.Name != service.Name || deployment.Namespace != input.Namespace || service.Namespace != input.Namespace {
		t.Fatalf("resource identity = deployment %s/%s service %s/%s", deployment.Namespace, deployment.Name, service.Namespace, service.Name)
	}
	if deployment.Spec.Replicas == nil || *deployment.Spec.Replicas != 1 {
		t.Fatalf("replicas = %v, want 1", deployment.Spec.Replicas)
	}
	if deployment.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatalf("strategy = %q, want Recreate", deployment.Spec.Strategy.Type)
	}
	if !reflect.DeepEqual(deployment.Spec.Selector.MatchLabels, service.Spec.Selector) {
		t.Fatalf("service selector %v does not match deployment selector %v", service.Spec.Selector, deployment.Spec.Selector.MatchLabels)
	}
	if service.Spec.Type != corev1.ServiceTypeClusterIP || len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Port != 80 || service.Spec.Ports[0].TargetPort.StrVal != "http" {
		t.Fatalf("service contract = %+v", service.Spec)
	}

	pod := deployment.Spec.Template.Spec
	if pod.TerminationGracePeriodSeconds == nil || *pod.TerminationGracePeriodSeconds != 60 {
		t.Fatalf("termination grace period = %v, want 60 seconds", pod.TerminationGracePeriodSeconds)
	}
	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Fatal("service-account token automount is not disabled")
	}
	if pod.EnableServiceLinks == nil || *pod.EnableServiceLinks {
		t.Fatal("service links are not disabled")
	}
	if pod.SecurityContext == nil || pod.SecurityContext.RunAsNonRoot == nil || !*pod.SecurityContext.RunAsNonRoot ||
		pod.SecurityContext.RunAsUser == nil || *pod.SecurityContext.RunAsUser != 10001 ||
		pod.SecurityContext.RunAsGroup == nil || *pod.SecurityContext.RunAsGroup != 10001 ||
		pod.SecurityContext.FSGroup == nil || *pod.SecurityContext.FSGroup != 10001 {
		t.Fatalf("pod security context = %+v", pod.SecurityContext)
	}
	if len(pod.InitContainers) != 1 || len(pod.Containers) != 1 {
		t.Fatalf("containers = %d init, %d main", len(pod.InitContainers), len(pod.Containers))
	}
	init := pod.InitContainers[0]
	runtime := pod.Containers[0]
	assertHardenedContainer(t, init)
	assertHardenedContainer(t, runtime)
	if !containsAll(init.Args, "materialize-bundle", input.BundleURL, input.ConfigHash) {
		t.Fatalf("init args = %v", init.Args)
	}
	if !containsAll(runtime.Args, "serve", "--config", "--data", ":8080", "--managed-storage") {
		t.Fatalf("runtime args = %v", runtime.Args)
	}
	assertArgumentValue(t, runtime.Args, "--storage-id", input.Storage.StorageID)
	assertArgumentValue(t, runtime.Args, "--deployment-id", input.DeploymentID)
	assertArgumentValue(t, runtime.Args, "--revision", "7")
	assertArgumentValue(t, runtime.Args, "--generation", "11")
	assertArgumentValue(t, runtime.Args, "--expected-config-hash", input.ConfigHash)
	if hasVolumeMount(runtime.VolumeMounts, "delivery-token") {
		t.Fatal("runtime container can access the bundle-delivery token")
	}
	if !hasVolumeMount(init.VolumeMounts, "delivery-token") || !hasVolumeMount(init.VolumeMounts, "bundle") {
		t.Fatalf("init volume mounts = %+v", init.VolumeMounts)
	}
	deliveryTokenVolume := findVolume(pod.Volumes, "delivery-token")
	if deliveryTokenVolume == nil || deliveryTokenVolume.Secret == nil || deliveryTokenVolume.Secret.DefaultMode == nil || *deliveryTokenVolume.Secret.DefaultMode != 0o440 {
		t.Fatalf("delivery-token volume = %+v, want non-root-readable mode 0440", deliveryTokenVolume)
	}
	if !hasReadOnlyVolumeMount(runtime.VolumeMounts, "bundle") || !hasVolumeMount(runtime.VolumeMounts, "state") || !hasVolumeMount(runtime.VolumeMounts, "tmp") {
		t.Fatalf("runtime volume mounts = %+v", runtime.VolumeMounts)
	}
	stateVolume := findVolume(pod.Volumes, "state")
	if stateVolume == nil || stateVolume.PersistentVolumeClaim == nil || stateVolume.PersistentVolumeClaim.ClaimName != persistentVolumeClaim.Name {
		t.Fatalf("state volume = %+v, want PVC %q", stateVolume, persistentVolumeClaim.Name)
	}
	if runtime.ReadinessProbe == nil || runtime.ReadinessProbe.HTTPGet == nil || runtime.ReadinessProbe.HTTPGet.Path != "/readyz" {
		t.Fatalf("readiness probe = %+v", runtime.ReadinessProbe)
	}
	if runtime.LivenessProbe == nil || runtime.LivenessProbe.HTTPGet == nil || runtime.LivenessProbe.HTTPGet.Path != "/healthz" {
		t.Fatalf("liveness probe = %+v", runtime.LivenessProbe)
	}
	if runtime.StartupProbe == nil || runtime.StartupProbe.HTTPGet == nil || runtime.StartupProbe.HTTPGet.Path != "/readyz" {
		t.Fatalf("startup probe = %+v", runtime.StartupProbe)
	}
	assertRuntimeSecretEnvironment(t, runtime.Env, input.RuntimeSecretName)
	if got := deployment.Spec.Template.Annotations["agentflow.dev/config-hash"]; got != input.ConfigHash {
		t.Fatalf("config-hash annotation = %q", got)
	}
}

func TestRenderKeepsLogicalResourcesStableAcrossRevisions(t *testing.T) {
	t.Parallel()
	firstInput := validWorkloadInput(t)
	first, err := kubernetes.Render(firstInput)
	if err != nil {
		t.Fatal(err)
	}
	secondInput := validWorkloadInput(t)
	secondInput.Revision = 8
	secondInput.Generation = 12
	secondInput.ConfigHash = strings.Repeat("b", 64)
	secondInput.BundleURL = "https://control-plane.internal/bundles/8"
	second, err := kubernetes.Render(secondInput)
	if err != nil {
		t.Fatal(err)
	}
	if first.Deployment.Name != second.Deployment.Name || first.Service.Name != second.Service.Name {
		t.Fatalf("logical resource names changed: %q/%q to %q/%q", first.Deployment.Name, first.Service.Name, second.Deployment.Name, second.Service.Name)
	}
	if first.PersistentVolumeClaim.Name != second.PersistentVolumeClaim.Name ||
		first.PersistentVolumeClaim.Namespace != second.PersistentVolumeClaim.Namespace ||
		first.PersistentVolumeClaim.Annotations["agentflow.dev/storage-id"] != second.PersistentVolumeClaim.Annotations["agentflow.dev/storage-id"] {
		t.Fatalf("stable PVC identity changed: %s/%s to %s/%s", first.PersistentVolumeClaim.Namespace, first.PersistentVolumeClaim.Name, second.PersistentVolumeClaim.Namespace, second.PersistentVolumeClaim.Name)
	}
	if !reflect.DeepEqual(first.Service.Spec.Selector, second.Service.Spec.Selector) {
		t.Fatalf("stable service selector changed: %v to %v", first.Service.Spec.Selector, second.Service.Spec.Selector)
	}
	if first.Deployment.Spec.Template.Annotations["agentflow.dev/config-hash"] == second.Deployment.Spec.Template.Annotations["agentflow.dev/config-hash"] {
		t.Fatal("revision-specific pod identity did not change")
	}
}

func TestRenderAcceptsVerifiedAndRetainedStorage(t *testing.T) {
	t.Parallel()
	for _, phase := range []deploymentmodel.StoragePhase{deploymentmodel.StoragePhaseReady, deploymentmodel.StoragePhaseRetained} {
		t.Run(string(phase), func(t *testing.T) {
			t.Parallel()
			input := validWorkloadInput(t)
			input.Storage.Phase = phase
			input.Storage.PVCUID = "0f4e0d43-79f4-4bfa-9078-d697e95b3b9f"
			input.Storage.StorageClassName = "standard"
			input.Storage.CapacityBytes = deploymentmodel.DefaultStorageCapacityBytes
			workload, err := kubernetes.Render(input)
			if err != nil {
				t.Fatal(err)
			}
			if workload.PersistentVolumeClaim.Name != input.Storage.PVCName {
				t.Fatalf("PVC name = %q", workload.PersistentVolumeClaim.Name)
			}
		})
	}
}

func TestStableResourceNameScopesByOwnerAndBoundsLength(t *testing.T) {
	t.Parallel()
	longID := strings.Repeat("Long_deployment.name-", 10)
	first, err := kubernetes.StableResourceName("owner-a", longID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := kubernetes.StableResourceName("owner-b", longID)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("different owners received the same stable resource name")
	}
	if len(first) > 63 || strings.ToLower(first) != first || strings.HasSuffix(first, "-") {
		t.Fatalf("stable name = %q", first)
	}
}

func TestRenderRejectsUnsafeOrIncompleteInputs(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*kubernetes.WorkloadInput)
	}{
		{name: "missing owner", mutate: func(input *kubernetes.WorkloadInput) { input.OwnerID = "" }},
		{name: "invalid namespace", mutate: func(input *kubernetes.WorkloadInput) { input.Namespace = "Not_DNS" }},
		{name: "zero revision", mutate: func(input *kubernetes.WorkloadInput) { input.Revision = 0 }},
		{name: "zero generation", mutate: func(input *kubernetes.WorkloadInput) { input.Generation = 0 }},
		{name: "zero schema", mutate: func(input *kubernetes.WorkloadInput) { input.SchemaVersion = 0 }},
		{name: "malformed hash", mutate: func(input *kubernetes.WorkloadInput) { input.ConfigHash = "bad" }},
		{name: "mutable image tag", mutate: func(input *kubernetes.WorkloadInput) { input.Image = "registry.example/agentflow-runtime:latest" }},
		{name: "empty image name", mutate: func(input *kubernetes.WorkloadInput) { input.Image = "@sha256:" + strings.Repeat("c", 64) }},
		{name: "image whitespace", mutate: func(input *kubernetes.WorkloadInput) {
			input.Image = "registry.example/agent flow@sha256:" + strings.Repeat("c", 64)
		}},
		{name: "plain HTTP bundle", mutate: func(input *kubernetes.WorkloadInput) { input.BundleURL = "http://control-plane.internal/bundles/7" }},
		{name: "bundle query", mutate: func(input *kubernetes.WorkloadInput) { input.BundleURL += "?token=secret" }},
		{name: "invalid delivery Secret", mutate: func(input *kubernetes.WorkloadInput) { input.DeliveryTokenSecretName = "Bad_Name" }},
		{name: "invalid runtime Secret", mutate: func(input *kubernetes.WorkloadInput) { input.RuntimeSecretName = "Bad_Name" }},
		{name: "invalid PVC", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.PVCName = "Bad_Name" }},
		{name: "storage namespace mismatch", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.Namespace = "other-runtimes" }},
		{name: "foreign storage identity", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.StorageID = strings.Repeat("d", 64) }},
		{name: "unprovisioned storage", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.Phase = deploymentmodel.StoragePhaseUnprovisioned }},
		{name: "missing storage", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.Phase = deploymentmodel.StoragePhaseMissing }},
		{name: "migration required", mutate: func(input *kubernetes.WorkloadInput) {
			input.Storage.Phase = deploymentmodel.StoragePhaseMigrationRequired
		}},
		{name: "planned storage with verified UID", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.PVCUID = "unexpected-uid" }},
		{name: "ready storage without binding", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.Phase = deploymentmodel.StoragePhaseReady }},
		{name: "legacy storage evidence", mutate: func(input *kubernetes.WorkloadInput) { input.Storage.LegacyPVCName = "legacy-claim" }},
		{name: "invalid environment name", mutate: func(input *kubernetes.WorkloadInput) { input.RuntimeSecretEnvNames = []string{"1TOKEN"} }},
		{name: "reserved environment name", mutate: func(input *kubernetes.WorkloadInput) { input.RuntimeSecretEnvNames = []string{"PATH"} }},
		{name: "Kubernetes environment name", mutate: func(input *kubernetes.WorkloadInput) {
			input.RuntimeSecretEnvNames = []string{"KUBERNETES_SERVICE_HOST"}
		}},
		{name: "duplicate environment name", mutate: func(input *kubernetes.WorkloadInput) {
			input.RuntimeSecretEnvNames = []string{"CONTEXT7_TOKEN", "CONTEXT7_TOKEN"}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			input := validWorkloadInput(t)
			tc.mutate(&input)
			if _, err := kubernetes.Render(input); err == nil {
				t.Fatal("Render succeeded")
			}
		})
	}
}

func validWorkloadInput(t *testing.T) kubernetes.WorkloadInput {
	t.Helper()
	plan, err := deploymentmodel.NewStoragePlan(
		"507f1f77bcf86cd799439011",
		"507f1f77bcf86cd799439012",
		"agentflow-runtimes",
	)
	if err != nil {
		t.Fatal(err)
	}
	return kubernetes.WorkloadInput{
		Namespace: "agentflow-runtimes", OwnerID: "507f1f77bcf86cd799439011", DeploymentID: "507f1f77bcf86cd799439012",
		Revision: 7, Generation: 11, SchemaVersion: 1, ConfigHash: strings.Repeat("a", 64),
		Image:                   "registry.example/agentflow-runtime@sha256:" + strings.Repeat("c", 64),
		BundleURL:               "https://control-plane.internal/bundles/7",
		DeliveryTokenSecretName: "af-delivery-token", DeliveryTokenID: "delivery-token-id", RuntimeSecretName: "af-runtime-secrets",
		RuntimeCredentialID:   "runtime-credential-id",
		RuntimeSecretEnvNames: []string{"OPENAI_API_KEY", "CONTEXT7_TOKEN"},
		Storage: deploymentmodel.StorageState{
			StoragePlan: plan,
			Phase:       deploymentmodel.StoragePhasePlanned,
		},
	}
}

func assertArgumentValue(t *testing.T, args []string, name, expected string) {
	t.Helper()
	for i := 0; i < len(args)-1; i++ {
		if args[i] == name {
			if args[i+1] != expected {
				t.Fatalf("argument %s = %q, want %q", name, args[i+1], expected)
			}
			return
		}
	}
	t.Fatalf("argument %s is missing from %v", name, args)
}

func assertHardenedContainer(t *testing.T, container corev1.Container) {
	t.Helper()
	ctx := container.SecurityContext
	if ctx == nil || ctx.AllowPrivilegeEscalation == nil || *ctx.AllowPrivilegeEscalation ||
		ctx.ReadOnlyRootFilesystem == nil || !*ctx.ReadOnlyRootFilesystem || ctx.Capabilities == nil ||
		len(ctx.Capabilities.Drop) != 1 || ctx.Capabilities.Drop[0] != "ALL" {
		t.Fatalf("container %q security context = %+v", container.Name, ctx)
	}
}

func assertRuntimeSecretEnvironment(t *testing.T, env []corev1.EnvVar, secretName string) {
	t.Helper()
	wantNames := []string{"RUNTIME_AUTH_MODE", "RUNTIME_API_TOKEN", "CONTEXT7_TOKEN", "OPENAI_API_KEY"}
	if len(env) != len(wantNames) {
		t.Fatalf("runtime env = %+v", env)
	}
	for i, want := range wantNames {
		if env[i].Name != want {
			t.Fatalf("env[%d].Name = %q, want %q", i, env[i].Name, want)
		}
		if want == "RUNTIME_AUTH_MODE" {
			if env[i].Value != "bearer" || env[i].ValueFrom != nil {
				t.Fatalf("runtime auth mode env = %+v", env[i])
			}
			continue
		}
		ref := env[i].ValueFrom
		if ref == nil || ref.SecretKeyRef == nil || ref.SecretKeyRef.Name != secretName || ref.SecretKeyRef.Key != want {
			t.Fatalf("secret env %q = %+v", want, env[i])
		}
	}
}

func containsAll(values []string, wanted ...string) bool {
	for _, want := range wanted {
		found := false
		for _, value := range values {
			if value == want {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func hasVolumeMount(mounts []corev1.VolumeMount, name string) bool {
	for _, mount := range mounts {
		if mount.Name == name {
			return true
		}
	}
	return false
}

func hasReadOnlyVolumeMount(mounts []corev1.VolumeMount, name string) bool {
	for _, mount := range mounts {
		if mount.Name == name {
			return mount.ReadOnly
		}
	}
	return false
}

func findVolume(volumes []corev1.Volume, name string) *corev1.VolumeSource {
	for i := range volumes {
		if volumes[i].Name == name {
			return &volumes[i].VolumeSource
		}
	}
	return nil
}
