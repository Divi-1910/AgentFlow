package kubernetes

import (
	"errors"
	"fmt"

	"backend/deployment"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

// ErrRuntimeCredentialUnavailable means the trusted source Secret does not
// contain a nonempty value required by the deployment's credential plan.
var ErrRuntimeCredentialUnavailable = errors.New("kubernetes runtime Secret: required credential unavailable")

// RuntimeSecretInput contains trusted controller inputs used to derive one
// deployment's least-privilege runtime Secret. Source is the AgentFlow-owned
// platform Secret; only keys named by Plan are copied.
type RuntimeSecretInput struct {
	Namespace       string
	Name            string
	OwnerID         string
	DeploymentID    string
	Generation      int64
	Revision        int
	Plan            deployment.RuntimeCredentialPlan
	Source          *corev1.Secret
	RuntimeAPIToken string
}

// RenderRuntimeSecret builds a per-deployment Secret without applying it to a
// cluster. Kubernetes reads and writes remain the responsibility of the future
// live adapter.
func RenderRuntimeSecret(input RuntimeSecretInput) (*corev1.Secret, error) {
	if errs := validation.IsDNS1123Label(input.Namespace); len(errs) != 0 {
		return nil, fmt.Errorf("kubernetes runtime Secret: invalid namespace: %v", errs)
	}
	if errs := validation.IsDNS1123Subdomain(input.Name); len(errs) != 0 {
		return nil, fmt.Errorf("kubernetes runtime Secret: invalid name: %v", errs)
	}
	if input.Source == nil {
		return nil, errors.New("kubernetes runtime Secret: AgentFlow credential source is required")
	}
	if input.OwnerID == "" || input.DeploymentID == "" || input.Generation <= 0 || input.Revision <= 0 {
		return nil, errors.New("kubernetes runtime Secret: owner, deployment, generation, and revision are required")
	}
	if len(input.Plan.EnvNames) == 0 {
		return nil, errors.New("kubernetes runtime Secret: credential plan is empty")
	}
	if err := validateRuntimeSecretEnvNames(input.Plan.EnvNames); err != nil {
		return nil, fmt.Errorf("kubernetes runtime Secret: %w", err)
	}
	if err := deployment.ValidateRuntimeAPIToken(input.RuntimeAPIToken); err != nil {
		return nil, fmt.Errorf("kubernetes runtime Secret: %w", err)
	}

	data := make(map[string][]byte, len(input.Plan.EnvNames)+1)
	data[deployment.RuntimeAPITokenEnvName] = []byte(input.RuntimeAPIToken)
	for _, envName := range input.Plan.EnvNames {
		value, ok := input.Source.Data[envName]
		if !ok || len(value) == 0 {
			return nil, fmt.Errorf("%w: %s", ErrRuntimeCredentialUnavailable, envName)
		}
		data[envName] = append([]byte(nil), value...)
	}

	labels, annotations := managedMetadata(input.OwnerID, input.DeploymentID, input.Generation, input.Revision)
	return &corev1.Secret{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"},
		ObjectMeta: metav1.ObjectMeta{
			Namespace:   input.Namespace,
			Name:        input.Name,
			Labels:      labels,
			Annotations: annotations,
		},
		Type: corev1.SecretTypeOpaque,
		Data: data,
	}, nil
}
