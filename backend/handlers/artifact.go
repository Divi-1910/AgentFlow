package handlers

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"backend/deployment/delivery"
	"backend/middleware"
)

const (
	maxDeliveryAuthorizationHeaderBytes = 256
	maxArtifactDeploymentIDBytes        = 128
)

type artifactDeliveryService interface {
	Authorize(ctx context.Context, request delivery.AuthorizeRequest) (*delivery.AuthorizedBundle, error)
}

type ArtifactHandler struct{ service artifactDeliveryService }

func NewArtifactHandler(service artifactDeliveryService) *ArtifactHandler {
	return &ArtifactHandler{service: service}
}

// GetBundle serves the internal managed-hosting path. Authentication is a
// deployment-scoped capability, not a Studio user session.
func (h *ArtifactHandler) GetBundle(w http.ResponseWriter, r *http.Request) {
	deploymentID := r.PathValue("deployment")
	generation, generationErr := strconv.ParseInt(r.PathValue("generation"), 10, 64)
	revision, revisionErr := strconv.Atoi(r.PathValue("revision"))
	if !validArtifactDeploymentID(deploymentID) || generationErr != nil || generation <= 0 || revisionErr != nil || revision <= 0 {
		writeError(w, http.StatusBadRequest, "invalid artifact scope")
		return
	}

	token, ok := deliveryBearerToken(r.Header.Values("Authorization"))
	if !ok {
		writeArtifactUnauthorized(w)
		return
	}

	authorized, err := h.service.Authorize(r.Context(), delivery.AuthorizeRequest{
		Token: token, DeploymentID: deploymentID, Generation: generation, Revision: revision,
	})
	if err != nil {
		if errors.Is(err, delivery.ErrUnauthorized) {
			middleware.LoggerFromContext(r.Context()).Warn("artifact delivery authorization rejected",
				"deployment_id", deploymentID, "generation", generation, "revision", revision)
			writeArtifactUnauthorized(w)
			return
		}
		middleware.LoggerFromContext(r.Context()).Error("artifact delivery failed", "deployment_id", deploymentID,
			"generation", generation, "revision", revision, "error", err)
		writeError(w, http.StatusInternalServerError, "artifact delivery failed")
		return
	}
	if authorized == nil || authorized.TokenID == "" || len(authorized.Revision.BundleJSON) == 0 {
		middleware.LoggerFromContext(r.Context()).Error("artifact delivery service returned an invalid result", "deployment_id", deploymentID,
			"generation", generation, "revision", revision)
		writeError(w, http.StatusInternalServerError, "artifact delivery failed")
		return
	}

	raw := authorized.Revision.BundleJSON
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(raw); err != nil {
		middleware.LoggerFromContext(r.Context()).Error("write deployment artifact failed", "deployment_id", deploymentID,
			"generation", generation, "revision", revision, "token_id", authorized.TokenID, "error", err)
		return
	}
	middleware.LoggerFromContext(r.Context()).Info("deployment artifact delivered",
		"deployment_id", deploymentID, "generation", generation, "revision", revision,
		"token_id", authorized.TokenID, "bytes", len(raw))
}

func deliveryBearerToken(values []string) (string, bool) {
	if len(values) != 1 || len(values[0]) > maxDeliveryAuthorizationHeaderBytes {
		return "", false
	}
	scheme, token, found := strings.Cut(values[0], " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}

func validArtifactDeploymentID(value string) bool {
	if len(value) == 0 || len(value) > maxArtifactDeploymentIDBytes {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return false
		}
	}
	return true
}

func writeArtifactUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="agentflow-artifacts"`)
	w.Header().Set("Cache-Control", "no-store")
	writeError(w, http.StatusUnauthorized, "unauthorized")
}
