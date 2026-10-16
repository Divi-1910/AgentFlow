package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"backend/deployment"
)

type runtimeAccessResolver interface {
	ResolveAccess(context.Context, deployment.DeployState) (deployment.RuntimeAccess, error)
}

type RuntimeProxyHandler struct {
	states    deploymentService
	resolver  runtimeAccessResolver
	transport http.RoundTripper
}

func NewRuntimeProxyHandler(states deploymentService, resolver runtimeAccessResolver, transport http.RoundTripper) (*RuntimeProxyHandler, error) {
	if states == nil || resolver == nil {
		return nil, errors.New("runtime proxy: deployment service and access resolver are required")
	}
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &RuntimeProxyHandler{states: states, resolver: resolver, transport: transport}, nil
}

func (h *RuntimeProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	deploymentID := r.PathValue("id")
	state, err := h.states.Get(r.Context(), userID, deploymentID)
	if err != nil {
		h.writeAccessError(w, deploymentID, err)
		return
	}
	if state == nil {
		h.writeAccessError(w, deploymentID, deployment.ErrDeployStateNotFound)
		return
	}
	access, err := h.resolver.ResolveAccess(r.Context(), *state)
	if err != nil {
		h.writeAccessError(w, deploymentID, err)
		return
	}
	target, err := url.Parse(access.BaseURL)
	if err != nil || target.Scheme != "http" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		h.writeAccessError(w, deploymentID, deployment.ErrRuntimeAccessUnavailable)
		return
	}
	if err := deployment.ValidateRuntimeAPIToken(access.BearerToken); err != nil {
		h.writeAccessError(w, deploymentID, deployment.ErrRuntimeAccessUnavailable)
		return
	}

	runtimePath := r.PathValue("path")
	proxy := &httputil.ReverseProxy{
		Transport: h.transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.Out.Header.Del("Authorization")
			request.Out.Header.Del("Cookie")
			request.Out.Header.Del("X-Forwarded-For")
			request.Out.Header.Del("X-Forwarded-Host")
			request.Out.Header.Del("X-Forwarded-Proto")
			request.SetURL(target)
			request.Out.Host = target.Host
			request.Out.URL.Path = "/" + strings.TrimPrefix(runtimePath, "/")
			request.Out.URL.RawPath = ""
			request.SetXForwarded()
			request.Out.Header.Set("Authorization", "Bearer "+access.BearerToken)
		},
		ModifyResponse: func(response *http.Response) error {
			deleteHeadersFold(response.Header, "Set-Cookie", "WWW-Authenticate", "Server")
			return nil
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, proxyErr error) {
			slog.Warn("runtime proxy request failed", "deployment_id", deploymentID, "error", proxyErr)
			writeError(response, http.StatusBadGateway, "deployment runtime is temporarily unavailable")
		},
	}
	proxy.ServeHTTP(w, r)
}

func deleteHeadersFold(header http.Header, names ...string) {
	for key := range header {
		for _, name := range names {
			if strings.EqualFold(key, name) {
				delete(header, key)
				break
			}
		}
	}
}

func (h *RuntimeProxyHandler) writeAccessError(w http.ResponseWriter, deploymentID string, err error) {
	switch {
	case errors.Is(err, deployment.ErrDeployStateNotFound), errors.Is(err, deployment.ErrRevisionNotFound):
		writeError(w, http.StatusNotFound, "deployment not found")
	case errors.Is(err, deployment.ErrRuntimeNotReady):
		writeError(w, http.StatusConflict, "deployment runtime is not ready")
	case errors.Is(err, deployment.ErrRuntimeAccessUnavailable):
		slog.Warn("runtime access resolution failed", "deployment_id", deploymentID, "error", err)
		writeError(w, http.StatusServiceUnavailable, "deployment runtime access is temporarily unavailable")
	default:
		slog.Error("runtime access failed", "deployment_id", deploymentID, "error", err)
		writeError(w, http.StatusInternalServerError, "deployment runtime access failed")
	}
}
