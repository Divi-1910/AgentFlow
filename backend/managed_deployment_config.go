package main

import (
	"errors"
	"fmt"
	"strings"
)

type managedDeploymentConfig struct {
	Enabled                   bool
	Namespace                 string
	RuntimeImage              string
	ArtifactBaseURL           string
	ArtifactListenAddr        string
	CredentialSourceNamespace string
	CredentialSourceName      string
	ControllerOwner           string
}

func loadManagedDeploymentConfig(getenv func(string) string, hostname func() (string, error)) (managedDeploymentConfig, error) {
	rawEnabled := strings.TrimSpace(getenv("MANAGED_DEPLOYMENTS_ENABLED"))
	if rawEnabled == "" || rawEnabled == "false" {
		return managedDeploymentConfig{}, nil
	}
	if rawEnabled != "true" {
		return managedDeploymentConfig{}, errors.New("MANAGED_DEPLOYMENTS_ENABLED must be true or false")
	}
	config := managedDeploymentConfig{
		Enabled:                   true,
		Namespace:                 strings.TrimSpace(getenv("DEPLOYMENT_NAMESPACE")),
		RuntimeImage:              strings.TrimSpace(getenv("DEPLOYMENT_RUNTIME_IMAGE")),
		ArtifactBaseURL:           strings.TrimSpace(getenv("DEPLOYMENT_ARTIFACT_BASE_URL")),
		ArtifactListenAddr:        strings.TrimSpace(getenv("ARTIFACT_LISTEN_ADDR")),
		CredentialSourceNamespace: strings.TrimSpace(getenv("DEPLOYMENT_CREDENTIAL_SECRET_NAMESPACE")),
		CredentialSourceName:      strings.TrimSpace(getenv("DEPLOYMENT_CREDENTIAL_SECRET_NAME")),
		ControllerOwner:           strings.TrimSpace(getenv("DEPLOYMENT_CONTROLLER_OWNER")),
	}
	if config.ControllerOwner == "" {
		config.ControllerOwner = strings.TrimSpace(getenv("POD_NAME"))
	}
	if config.ControllerOwner == "" {
		name, err := hostname()
		if err != nil {
			return managedDeploymentConfig{}, fmt.Errorf("resolve deployment controller owner: %w", err)
		}
		config.ControllerOwner = strings.TrimSpace(name)
	}
	required := map[string]string{
		"DEPLOYMENT_NAMESPACE":                   config.Namespace,
		"DEPLOYMENT_RUNTIME_IMAGE":               config.RuntimeImage,
		"DEPLOYMENT_ARTIFACT_BASE_URL":           config.ArtifactBaseURL,
		"ARTIFACT_LISTEN_ADDR":                   config.ArtifactListenAddr,
		"DEPLOYMENT_CREDENTIAL_SECRET_NAMESPACE": config.CredentialSourceNamespace,
		"DEPLOYMENT_CREDENTIAL_SECRET_NAME":      config.CredentialSourceName,
		"deployment controller owner":            config.ControllerOwner,
	}
	for name, value := range required {
		if value == "" {
			return managedDeploymentConfig{}, fmt.Errorf("%s is required when managed deployments are enabled", name)
		}
	}
	return config, nil
}
