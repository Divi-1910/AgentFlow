package kubernetes

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	managedByLabel              = "app.kubernetes.io/managed-by"
	deploymentIdentityLabel     = "agentflow.dev/deployment"
	deploymentIdentityAnnot     = "agentflow.dev/deployment-identity"
	deploymentIDAnnotation      = "agentflow.dev/deployment-id"
	generationAnnotation        = "agentflow.dev/generation"
	revisionAnnotation          = "agentflow.dev/revision"
	deliveryTokenIDAnnotation   = "agentflow.dev/delivery-token-id"
	runtimeCredentialAnnotation = "agentflow.dev/runtime-credential-id"
	managedByAgentFlow          = "agentflow"
)

func deploymentIdentity(ownerID, deploymentID string) string {
	digest := sha256.Sum256([]byte(ownerID + "\x00" + deploymentID))
	return hex.EncodeToString(digest[:])
}

func managedMetadata(ownerID, deploymentID string, generation int64, revision int) (map[string]string, map[string]string) {
	identity := deploymentIdentity(ownerID, deploymentID)
	labels := map[string]string{
		managedByLabel:          managedByAgentFlow,
		deploymentIdentityLabel: identity[:40],
	}
	annotations := map[string]string{
		deploymentIdentityAnnot: identity,
		deploymentIDAnnotation:  deploymentID,
		generationAnnotation:    strconv.FormatInt(generation, 10),
		revisionAnnotation:      strconv.Itoa(revision),
	}
	return labels, annotations
}

func mergeStringMap(base map[string]string, additions map[string]string) map[string]string {
	merged := cloneMap(base)
	for key, value := range additions {
		merged[key] = value
	}
	return merged
}

func isManagedFor(meta metav1.Object, ownerID, deploymentID string) bool {
	labels := meta.GetLabels()
	annotations := meta.GetAnnotations()
	return labels[managedByLabel] == managedByAgentFlow &&
		annotations[deploymentIdentityAnnot] == deploymentIdentity(ownerID, deploymentID)
}
