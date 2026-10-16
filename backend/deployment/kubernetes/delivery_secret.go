package kubernetes

import (
	"errors"
	"fmt"
	"strings"

	"backend/deployment/delivery"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

type DeliverySecretInput struct {
	Namespace    string
	Name         string
	OwnerID      string
	DeploymentID string
	Credential   *delivery.Credential
}

func RenderDeliverySecret(input DeliverySecretInput) (*corev1.Secret, error) {
	if errs := validation.IsDNS1123Label(input.Namespace); len(errs) != 0 {
		return nil, fmt.Errorf("kubernetes delivery Secret: invalid namespace: %v", errs)
	}
	if errs := validation.IsDNS1123Subdomain(input.Name); len(errs) != 0 {
		return nil, fmt.Errorf("kubernetes delivery Secret: invalid name: %v", errs)
	}
	if strings.TrimSpace(input.OwnerID) == "" || strings.TrimSpace(input.DeploymentID) == "" {
		return nil, errors.New("kubernetes delivery Secret: owner and deployment are required")
	}
	credential := input.Credential
	if credential == nil || credential.Token == "" || credential.TokenID == "" ||
		credential.UserID != input.OwnerID || credential.DeploymentID != input.DeploymentID ||
		credential.Generation <= 0 || credential.Revision <= 0 {
		return nil, errors.New("kubernetes delivery Secret: valid scoped credential is required")
	}
	labels, annotations := managedMetadata(
		input.OwnerID,
		input.DeploymentID,
		credential.Generation,
		credential.Revision,
	)
	annotations[deliveryTokenIDAnnotation] = credential.TokenID
	return &corev1.Secret{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"},
		ObjectMeta: metav1.ObjectMeta{
			Namespace:   input.Namespace,
			Name:        input.Name,
			Labels:      labels,
			Annotations: annotations,
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{"token": []byte(credential.Token)},
	}, nil
}
