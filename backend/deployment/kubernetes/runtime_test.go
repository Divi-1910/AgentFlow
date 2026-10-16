package kubernetes

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"backend/deployment"
	"backend/deployment/delivery"
	"backend/deployment/reconciler"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	kubeclient "k8s.io/client-go/kubernetes/fake"
	kubetesting "k8s.io/client-go/testing"
	"k8s.io/utils/ptr"
)

const runtimeTestImage = "registry.example/agentflow-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type runtimeStateReader struct{ state *deployment.DeployState }

func (r *runtimeStateReader) Get(context.Context, string, string) (*deployment.DeployState, error) {
	if r.state == nil {
		return nil, deployment.ErrDeployStateNotFound
	}
	copy := *r.state
	return &copy, nil
}

type runtimeDelivery struct {
	credential *delivery.Credential
	revoked    []int64
}

func (d *runtimeDelivery) Issue(_ context.Context, request delivery.IssueRequest) (*delivery.Credential, error) {
	if d.credential == nil {
		return nil, errors.New("credential unavailable")
	}
	copy := *d.credential
	if copy.UserID != request.UserID || copy.DeploymentID != request.DeploymentID || copy.Generation != request.Generation {
		return nil, errors.New("credential scope mismatch")
	}
	return &copy, nil
}

func (d *runtimeDelivery) RevokeGeneration(_ context.Context, _, _ string, generation int64) error {
	d.revoked = append(d.revoked, generation)
	return nil
}

type storageRecorder struct {
	ready   *deployment.StorageBindingObservation
	missing bool
}

func (r *storageRecorder) Ready(binding deployment.StorageBindingObservation) error {
	copy := binding
	r.ready = &copy
	return nil
}

func (r *storageRecorder) Missing() error {
	r.missing = true
	return nil
}

func TestRuntimeReconcileRunCreatesReadyOwnedWorkload(t *testing.T) {
	state, revision := runtimeAttempt(t, deployment.StoragePhasePlanned)
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	client := kubeclient.NewSimpleClientset(
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "provider-credentials", Namespace: "agentflow-system"},
			Data:       map[string][]byte{"OPENAI_API_KEY": []byte("platform-owned-key")},
		},
		&discoveryv1.EndpointSlice{
			ObjectMeta: metav1.ObjectMeta{
				Name: name + "-endpoint", Namespace: state.Desired.Target.Namespace,
				Labels: map[string]string{discoveryv1.LabelServiceName: name},
			},
			Endpoints: []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.12"}, Conditions: discoveryv1.EndpointConditions{Ready: ptr.To(true)}}},
		},
	)
	client.PrependReactor("create", "persistentvolumeclaims", func(action kubetesting.Action) (bool, runtime.Object, error) {
		pvc := action.(kubetesting.CreateAction).GetObject().(*corev1.PersistentVolumeClaim)
		pvc.UID = types.UID("pvc-uid-1")
		pvc.Spec.StorageClassName = ptr.To("standard")
		// WaitForFirstConsumer classes leave the claim Pending until a pod is
		// created. The Deployment reactor below simulates that binding point.
		pvc.Status.Phase = corev1.ClaimPending
		return false, nil, nil
	})
	client.PrependReactor("create", "deployments", func(action kubetesting.Action) (bool, runtime.Object, error) {
		object := action.(kubetesting.CreateAction).GetObject().(*appsv1.Deployment)
		object.Generation = 1
		object.Status.ObservedGeneration = 1
		object.Status.ReadyReplicas = 1
		object.Status.AvailableReplicas = 1
		tracked, getErr := client.Tracker().Get(
			corev1.SchemeGroupVersion.WithResource("persistentvolumeclaims"),
			state.Storage.Namespace,
			state.Storage.PVCName,
		)
		if getErr != nil {
			return true, nil, getErr
		}
		pvc := tracked.(*corev1.PersistentVolumeClaim)
		pvc.Status.Phase = corev1.ClaimBound
		pvc.Status.Capacity = corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("5Gi")}
		if updateErr := client.Tracker().Update(
			corev1.SchemeGroupVersion.WithResource("persistentvolumeclaims"),
			pvc,
			state.Storage.Namespace,
		); updateErr != nil {
			return true, nil, updateErr
		}
		return false, nil, nil
	})
	deliveryService := &runtimeDelivery{credential: &delivery.Credential{
		Token: "afdt_test-token", TokenID: "token-id-1", UserID: state.UserID,
		DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
		Revision: state.Desired.Target.Revision, ConfigHash: state.Desired.Target.ConfigHash,
		SchemaVersion: state.Desired.Target.SchemaVersion, ExpiresAt: time.Now().Add(time.Hour),
	}}
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: state}, deliveryService)
	storage := &storageRecorder{}
	var progress []deployment.DeploymentPhase
	result, err := runtimeAdapter.ReconcileRun(
		context.Background(),
		reconciler.RunAttempt{State: *state, Revision: *revision},
		func(phase deployment.DeploymentPhase, _ bool) error {
			progress = append(progress, phase)
			return nil
		},
		storage,
	)
	if err != nil {
		t.Fatal(err)
	}
	if storage.ready == nil || storage.ready.PVCUID != "pvc-uid-1" || storage.missing {
		t.Fatalf("storage observation = ready %+v missing %t", storage.ready, storage.missing)
	}
	if !slices.Equal(progress, []deployment.DeploymentPhase{deployment.DeploymentPhaseStarting}) {
		t.Fatalf("progress = %v", progress)
	}
	if result.Endpoint != "http://"+name+".agentflow-runtimes.svc.cluster.local" || result.Resources.DeploymentName != name {
		t.Fatalf("run result = %+v", result)
	}
	if !slices.Contains(deliveryService.revoked, state.Desired.Generation) {
		t.Fatalf("revoked generations = %v", deliveryService.revoked)
	}

	runtimeSecret, err := client.CoreV1().Secrets(state.Desired.Target.Namespace).Get(context.Background(), name+"-runtime", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if string(runtimeSecret.Data["OPENAI_API_KEY"]) != "platform-owned-key" || len(runtimeSecret.Data) != 2 {
		t.Fatalf("runtime Secret keys/data = %v", runtimeSecret.Data)
	}
	deliverySecret, err := client.CoreV1().Secrets(state.Desired.Target.Namespace).Get(context.Background(), name+"-delivery", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if string(deliverySecret.Data["token"]) != deliveryService.credential.Token {
		t.Fatal("delivery token was not materialized into the scoped Secret")
	}
	if !isManagedFor(runtimeSecret, state.UserID, state.DeploymentID) || !isManagedFor(deliverySecret, state.UserID, state.DeploymentID) {
		t.Fatal("rendered Secrets do not carry AgentFlow ownership identity")
	}

	// A controller may crash after Kubernetes is ready but before MongoDB is
	// updated. Repeating the same generation must inspect and safely converge
	// the existing resources instead of creating duplicates.
	retryStorage := &storageRecorder{}
	if _, err := runtimeAdapter.ReconcileRun(
		context.Background(),
		reconciler.RunAttempt{State: *state, Revision: *revision},
		func(deployment.DeploymentPhase, bool) error { return nil },
		retryStorage,
	); err != nil {
		t.Fatalf("repeat reconcile: %v", err)
	}
	if retryStorage.ready == nil || retryStorage.ready.PVCUID != "pvc-uid-1" {
		t.Fatalf("repeat storage observation = %+v", retryStorage.ready)
	}
	deployments, err := client.AppsV1().Deployments(state.Desired.Target.Namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil || len(deployments.Items) != 1 {
		t.Fatalf("deployments after repeat = %d, error = %v", len(deployments.Items), err)
	}
	services, err := client.CoreV1().Services(state.Desired.Target.Namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil || len(services.Items) != 1 {
		t.Fatalf("services after repeat = %d, error = %v", len(services.Items), err)
	}
	pvcs, err := client.CoreV1().PersistentVolumeClaims(state.Storage.Namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil || len(pvcs.Items) != 1 {
		t.Fatalf("PVCs after repeat = %d, error = %v", len(pvcs.Items), err)
	}
}

func TestRuntimeReconcileRunRecordsMissingRetainedPVC(t *testing.T) {
	state, revision := runtimeAttempt(t, deployment.StoragePhaseReady)
	state.Storage.PVCUID = "retained-pvc-uid"
	state.Storage.StorageClassName = "standard"
	state.Storage.CapacityBytes = deployment.DefaultStorageCapacityBytes
	client := kubeclient.NewSimpleClientset()
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: state}, &runtimeDelivery{})
	storage := &storageRecorder{}
	_, err := runtimeAdapter.ReconcileRun(
		context.Background(),
		reconciler.RunAttempt{State: *state, Revision: *revision},
		func(deployment.DeploymentPhase, bool) error { return nil },
		storage,
	)
	if err == nil || !storage.missing {
		t.Fatalf("error = %v, storage missing = %t", err, storage.missing)
	}
	var typed *reconciler.Error
	if !errors.As(err, &typed) || typed.Code != "storage_missing" || typed.Retryable {
		t.Fatalf("error = %#v", err)
	}
	actions := client.Actions()
	for _, action := range actions {
		if action.Matches("create", "persistentvolumeclaims") {
			t.Fatal("adapter recreated missing retained PVC")
		}
	}
}

func TestRuntimeReconcileRunRejectsForeignPVC(t *testing.T) {
	state, revision := runtimeAttempt(t, deployment.StoragePhasePlanned)
	foreign := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: state.Storage.PVCName, Namespace: state.Storage.Namespace},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("5Gi")},
			},
		},
	}
	client := kubeclient.NewSimpleClientset(foreign)
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: state}, &runtimeDelivery{})
	_, err := runtimeAdapter.ReconcileRun(
		context.Background(),
		reconciler.RunAttempt{State: *state, Revision: *revision},
		func(deployment.DeploymentPhase, bool) error { return nil },
		&storageRecorder{},
	)
	var typed *reconciler.Error
	if !errors.As(err, &typed) || typed.Code != "resource_conflict" || typed.Retryable {
		t.Fatalf("error = %#v", err)
	}
}

func TestRuntimeReconcileRunStopsBeforeClusterMutationWhenGenerationChanges(t *testing.T) {
	attemptState, revision := runtimeAttempt(t, deployment.StoragePhasePlanned)
	current := *attemptState
	current.Desired.Generation++
	client := kubeclient.NewSimpleClientset()
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: &current}, &runtimeDelivery{})
	_, err := runtimeAdapter.ReconcileRun(
		context.Background(),
		reconciler.RunAttempt{State: *attemptState, Revision: *revision},
		func(deployment.DeploymentPhase, bool) error { return nil },
		&storageRecorder{},
	)
	if !errors.Is(err, reconciler.ErrClaimLost) {
		t.Fatalf("error = %v, want claim lost", err)
	}
	if len(client.Actions()) != 0 {
		t.Fatalf("Kubernetes actions after generation fence failed = %+v", client.Actions())
	}
}

func TestRuntimeReconcileDeleteRemovesComputeAndRetainsPVC(t *testing.T) {
	state, _ := runtimeAttempt(t, deployment.StoragePhaseRetained)
	state.Desired.Action = deployment.DesiredActionDelete
	state.Desired.Generation = 8
	state.Observed.Generation = 7
	state.Storage.PVCUID = "pvc-uid-1"
	state.Storage.StorageClassName = "standard"
	state.Storage.CapacityBytes = deployment.DefaultStorageCapacityBytes
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	labels, annotations := managedMetadata(state.UserID, state.DeploymentID, 7, state.Desired.Target.Revision)
	objects := []runtime.Object{
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name + "-delivery", Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name + "-runtime", Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations}},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: state.Storage.PVCName, Namespace: state.Storage.Namespace, Labels: labels, Annotations: annotations}},
	}
	client := kubeclient.NewSimpleClientset(objects...)
	deliveryService := &runtimeDelivery{}
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: state}, deliveryService)
	if err := runtimeAdapter.ReconcileDelete(context.Background(), reconciler.DeleteAttempt{State: *state}); err != nil {
		t.Fatal(err)
	}
	if err := runtimeAdapter.ReconcileDelete(context.Background(), reconciler.DeleteAttempt{State: *state}); err != nil {
		t.Fatalf("repeat delete: %v", err)
	}
	for resource, get := range map[string]func() error{
		"Deployment": func() error {
			_, err := client.AppsV1().Deployments(state.Desired.Target.Namespace).Get(context.Background(), name, metav1.GetOptions{})
			return err
		},
		"Service": func() error {
			_, err := client.CoreV1().Services(state.Desired.Target.Namespace).Get(context.Background(), name, metav1.GetOptions{})
			return err
		},
		"delivery Secret": func() error {
			_, err := client.CoreV1().Secrets(state.Desired.Target.Namespace).Get(context.Background(), name+"-delivery", metav1.GetOptions{})
			return err
		},
		"runtime Secret": func() error {
			_, err := client.CoreV1().Secrets(state.Desired.Target.Namespace).Get(context.Background(), name+"-runtime", metav1.GetOptions{})
			return err
		},
	} {
		if err := get(); !apierrors.IsNotFound(err) {
			t.Fatalf("%s still exists or lookup failed: %v", resource, err)
		}
	}
	if _, err := client.CoreV1().PersistentVolumeClaims(state.Storage.Namespace).Get(context.Background(), state.Storage.PVCName, metav1.GetOptions{}); err != nil {
		t.Fatalf("retained PVC was removed: %v", err)
	}
	if !slices.Equal(deliveryService.revoked, []int64{7, 7}) {
		t.Fatalf("revoked generations = %v", deliveryService.revoked)
	}
}

func TestRuntimeResolveAccessRevalidatesReadyOwnedGeneration(t *testing.T) {
	state, _ := runtimeAttempt(t, deployment.StoragePhaseReady)
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	state.Observed = deployment.ObservedState{
		Generation: state.Desired.Generation, Phase: deployment.DeploymentPhaseReady, Ready: true,
		Resources: deployment.ResourceRefs{
			Namespace: state.Desired.Target.Namespace, ServiceName: name, RuntimeSecretName: name + "-runtime",
		},
	}
	labels, annotations := managedMetadata(state.UserID, state.DeploymentID, state.Desired.Generation, state.Desired.Target.Revision)
	token, err := deployment.NewRuntimeAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	client := kubeclient.NewSimpleClientset(
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations},
			Spec:       corev1.ServiceSpec{ClusterIP: "10.96.0.10"},
		},
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-runtime", Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations},
			Data:       map[string][]byte{deployment.RuntimeAPITokenEnvName: []byte(token)},
		},
		&discoveryv1.EndpointSlice{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-endpoint", Namespace: state.Desired.Target.Namespace, Labels: map[string]string{discoveryv1.LabelServiceName: name}},
			Endpoints:  []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.12"}, Conditions: discoveryv1.EndpointConditions{Ready: ptr.To(true)}}},
		},
	)
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: state}, &runtimeDelivery{})
	access, err := runtimeAdapter.ResolveAccess(context.Background(), *state)
	if err != nil {
		t.Fatal(err)
	}
	if access.BaseURL != "http://"+name+"."+state.Desired.Target.Namespace+".svc.cluster.local" || access.BearerToken != token {
		t.Fatalf("access = %+v", access)
	}
}

func TestRuntimeResolveAccessRejectsStaleOrUnreadyResources(t *testing.T) {
	state, _ := runtimeAttempt(t, deployment.StoragePhaseReady)
	name, err := StableResourceName(state.UserID, state.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	state.Observed = deployment.ObservedState{
		Generation: state.Desired.Generation, Phase: deployment.DeploymentPhaseReady, Ready: true,
		Resources: deployment.ResourceRefs{Namespace: state.Desired.Target.Namespace, ServiceName: name, RuntimeSecretName: name + "-runtime"},
	}
	labels, annotations := managedMetadata(state.UserID, state.DeploymentID, state.Desired.Generation-1, state.Desired.Target.Revision)
	client := kubeclient.NewSimpleClientset(&corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: state.Desired.Target.Namespace, Labels: labels, Annotations: annotations},
		Spec:       corev1.ServiceSpec{ClusterIP: "10.96.0.10"},
	})
	runtimeAdapter := newTestRuntime(t, client, &runtimeStateReader{state: state}, &runtimeDelivery{})
	_, err = runtimeAdapter.ResolveAccess(context.Background(), *state)
	if !errors.Is(err, deployment.ErrRuntimeAccessUnavailable) {
		t.Fatalf("stale resource error = %v", err)
	}

	state.Observed.Ready = false
	_, err = runtimeAdapter.ResolveAccess(context.Background(), *state)
	if !errors.Is(err, deployment.ErrRuntimeNotReady) {
		t.Fatalf("unready state error = %v", err)
	}
}

func newTestRuntime(t *testing.T, client *kubeclient.Clientset, states StateReader, credentials DeliveryCredentials) *Runtime {
	t.Helper()
	runtimeAdapter, err := NewRuntime(RuntimeConfig{
		Client: client, States: states, Delivery: credentials,
		ArtifactBaseURL:           "https://artifacts.agentflow.svc.cluster.local",
		CredentialSourceNamespace: "agentflow-system", CredentialSourceName: "provider-credentials",
		PollInterval: time.Millisecond, ReadyTimeout: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runtimeAdapter
}

func runtimeAttempt(t *testing.T, storagePhase deployment.StoragePhase) (*deployment.DeployState, *deployment.Revision) {
	t.Helper()
	bundle := deployment.Bundle{
		SchemaVersion: deployment.SchemaVersion, DeploymentID: "deployment-1", RootAgentID: "agent-1", PlatformXML: "<platform />",
		Agents: []deployment.BundleAgent{{
			ID: "agent-1", Name: "Agent", Description: "test", Provider: "openai", Model: "test-model",
			SystemPrompt: "Test", Tools: []string{}, Delegates: []deployment.BundleDelegate{}, MCPServers: []deployment.BundleMCPServer{},
			ModelContextLimit: 4096, ContextWindow: 2048, ContextKeepRatio: 0.8,
			SummarizationModel: "test-model", MaxSteps: 10, Temperature: 0.2, MaxTokens: 512, MaxRuns: 4,
		}},
	}
	hash, err := bundle.CanonicalHash()
	if err != nil {
		t.Fatal(err)
	}
	bundle.ConfigHash = hash
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := deployment.NewStoragePlan("507f1f77bcf86cd799439011", bundle.DeploymentID, "agentflow-runtimes")
	if err != nil {
		t.Fatal(err)
	}
	state := &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion,
		UserID:        "507f1f77bcf86cd799439011", DeploymentID: bundle.DeploymentID,
		Desired: deployment.DesiredState{Generation: 7, Action: deployment.DesiredActionRun, Target: deployment.DeploymentTarget{
			Revision: 1, ConfigHash: hash, SchemaVersion: deployment.SchemaVersion,
			Namespace: "agentflow-runtimes", RuntimeImage: runtimeTestImage,
		}},
		Storage: deployment.StorageState{StoragePlan: plan, Phase: storagePhase},
	}
	revision := &deployment.Revision{
		UserID: state.UserID, DeploymentID: state.DeploymentID, RootAgentID: bundle.RootAgentID,
		Revision: 1, ConfigHash: hash, SchemaVersion: deployment.SchemaVersion, BundleJSON: raw,
	}
	return state, revision
}
