package kubernetes_test

import (
	"errors"
	"reflect"
	"testing"

	"backend/deployment"
	"backend/deployment/kubernetes"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRenderRuntimeSecretCopiesOnlyPlannedCredentials(t *testing.T) {
	t.Parallel()
	token, err := deployment.NewRuntimeAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	source := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "agentflow-provider-credentials", Namespace: "agentflow-system"},
		Data: map[string][]byte{
			"OPENAI_API_KEY":  []byte("openai-secret"),
			"TAVILY_API_KEY":  []byte("tavily-secret"),
			"NVIDIA_API_KEY":  []byte("must-not-be-copied"),
			"UNRELATED_TOKEN": []byte("must-not-be-copied"),
		},
	}
	secret, err := kubernetes.RenderRuntimeSecret(kubernetes.RuntimeSecretInput{
		Namespace: "agentflow-runtimes",
		Name:      "af-runtime-example",
		OwnerID:   "507f1f77bcf86cd799439011", DeploymentID: "deployment-1", Generation: 2, Revision: 1,
		Plan: deployment.RuntimeCredentialPlan{EnvNames: []string{
			"OPENAI_API_KEY", "TAVILY_API_KEY",
		}},
		Source:          source,
		RuntimeAPIToken: token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if secret.APIVersion != "v1" || secret.Kind != "Secret" || secret.Type != corev1.SecretTypeOpaque ||
		secret.Namespace != "agentflow-runtimes" || secret.Name != "af-runtime-example" {
		t.Fatalf("runtime Secret metadata = %+v", secret)
	}
	want := map[string][]byte{
		deployment.RuntimeAPITokenEnvName: []byte(token),
		"OPENAI_API_KEY":                  []byte("openai-secret"),
		"TAVILY_API_KEY":                  []byte("tavily-secret"),
	}
	if !reflect.DeepEqual(secret.Data, want) {
		t.Fatalf("runtime Secret data = %v, want exact planned keys", secret.Data)
	}

	source.Data["OPENAI_API_KEY"][0] = 'X'
	if string(secret.Data["OPENAI_API_KEY"]) != "openai-secret" {
		t.Fatal("runtime Secret shares credential bytes with source Secret")
	}
	secret.Data["TAVILY_API_KEY"][0] = 'X'
	if string(source.Data["TAVILY_API_KEY"]) != "tavily-secret" {
		t.Fatal("source Secret shares credential bytes with rendered Secret")
	}
}

func TestRenderRuntimeSecretRejectsUnavailableCredential(t *testing.T) {
	t.Parallel()
	token, err := deployment.NewRuntimeAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		data map[string][]byte
	}{
		{name: "missing", data: map[string][]byte{}},
		{name: "empty", data: map[string][]byte{"OPENAI_API_KEY": {}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, renderErr := kubernetes.RenderRuntimeSecret(kubernetes.RuntimeSecretInput{
				Namespace: "agentflow-runtimes", Name: "af-runtime-example",
				OwnerID: "507f1f77bcf86cd799439011", DeploymentID: "deployment-1", Generation: 2, Revision: 1,
				Plan:   deployment.RuntimeCredentialPlan{EnvNames: []string{"OPENAI_API_KEY"}},
				Source: &corev1.Secret{Data: tc.data}, RuntimeAPIToken: token,
			})
			if !errors.Is(renderErr, kubernetes.ErrRuntimeCredentialUnavailable) {
				t.Fatalf("RenderRuntimeSecret error = %v, want unavailable credential", renderErr)
			}
		})
	}
}

func TestRenderRuntimeSecretRejectsUnsafeInput(t *testing.T) {
	t.Parallel()
	token, err := deployment.NewRuntimeAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	valid := kubernetes.RuntimeSecretInput{
		Namespace: "agentflow-runtimes", Name: "af-runtime-example",
		OwnerID: "507f1f77bcf86cd799439011", DeploymentID: "deployment-1", Generation: 2, Revision: 1,
		Plan:            deployment.RuntimeCredentialPlan{EnvNames: []string{"OPENAI_API_KEY"}},
		Source:          &corev1.Secret{Data: map[string][]byte{"OPENAI_API_KEY": []byte("secret")}},
		RuntimeAPIToken: token,
	}
	tests := []struct {
		name   string
		mutate func(*kubernetes.RuntimeSecretInput)
	}{
		{name: "invalid namespace", mutate: func(input *kubernetes.RuntimeSecretInput) { input.Namespace = "Bad_Namespace" }},
		{name: "invalid name", mutate: func(input *kubernetes.RuntimeSecretInput) { input.Name = "Bad_Name" }},
		{name: "missing source", mutate: func(input *kubernetes.RuntimeSecretInput) { input.Source = nil }},
		{name: "missing owner", mutate: func(input *kubernetes.RuntimeSecretInput) { input.OwnerID = "" }},
		{name: "empty plan", mutate: func(input *kubernetes.RuntimeSecretInput) { input.Plan.EnvNames = nil }},
		{name: "invalid token", mutate: func(input *kubernetes.RuntimeSecretInput) { input.RuntimeAPIToken = "predictable" }},
		{name: "reserved environment", mutate: func(input *kubernetes.RuntimeSecretInput) { input.Plan.EnvNames = []string{"PATH"} }},
		{name: "runtime token in plan", mutate: func(input *kubernetes.RuntimeSecretInput) {
			input.Plan.EnvNames = []string{deployment.RuntimeAPITokenEnvName}
		}},
		{name: "duplicate environment", mutate: func(input *kubernetes.RuntimeSecretInput) {
			input.Plan.EnvNames = []string{"OPENAI_API_KEY", "OPENAI_API_KEY"}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			input := valid
			input.Plan.EnvNames = append([]string(nil), valid.Plan.EnvNames...)
			tc.mutate(&input)
			if _, err := kubernetes.RenderRuntimeSecret(input); err == nil {
				t.Fatal("RenderRuntimeSecret succeeded")
			}
		})
	}
}
