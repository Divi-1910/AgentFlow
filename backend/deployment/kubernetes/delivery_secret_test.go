package kubernetes_test

import (
	"testing"
	"time"

	"backend/deployment/delivery"
	"backend/deployment/kubernetes"
)

func TestRenderDeliverySecretScopesCredentialAndOwnership(t *testing.T) {
	t.Parallel()
	credential := &delivery.Credential{
		Token: "afdt_test-token", TokenID: "token-id-1",
		UserID: "507f1f77bcf86cd799439011", DeploymentID: "deployment-1",
		Generation: 3, Revision: 2, ExpiresAt: time.Now().Add(time.Hour),
	}
	secret, err := kubernetes.RenderDeliverySecret(kubernetes.DeliverySecretInput{
		Namespace: "agentflow-runtimes", Name: "af-runtime-delivery",
		OwnerID: credential.UserID, DeploymentID: credential.DeploymentID, Credential: credential,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(secret.Data) != 1 || string(secret.Data["token"]) != credential.Token {
		t.Fatalf("delivery Secret data = %v", secret.Data)
	}
	if secret.Annotations["agentflow.dev/generation"] != "3" ||
		secret.Annotations["agentflow.dev/revision"] != "2" ||
		secret.Annotations["agentflow.dev/delivery-token-id"] != credential.TokenID {
		t.Fatalf("delivery Secret annotations = %v", secret.Annotations)
	}
}

func TestRenderDeliverySecretRejectsWrongScope(t *testing.T) {
	t.Parallel()
	credential := &delivery.Credential{
		Token: "afdt_test-token", TokenID: "token-id-1",
		UserID: "owner-a", DeploymentID: "deployment-1", Generation: 1, Revision: 1,
	}
	_, err := kubernetes.RenderDeliverySecret(kubernetes.DeliverySecretInput{
		Namespace: "agentflow-runtimes", Name: "af-runtime-delivery",
		OwnerID: "owner-b", DeploymentID: credential.DeploymentID, Credential: credential,
	})
	if err == nil {
		t.Fatal("RenderDeliverySecret accepted a credential for another owner")
	}
}
