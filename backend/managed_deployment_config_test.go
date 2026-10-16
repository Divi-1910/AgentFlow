package main

import (
	"errors"
	"testing"
)

func TestLoadManagedDeploymentConfig(t *testing.T) {
	base := map[string]string{
		"MANAGED_DEPLOYMENTS_ENABLED":            "true",
		"DEPLOYMENT_NAMESPACE":                   "agentflow-runtimes",
		"DEPLOYMENT_RUNTIME_IMAGE":               "registry.example/runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		"DEPLOYMENT_ARTIFACT_BASE_URL":           "https://artifacts.agentflow-system.svc.cluster.local",
		"ARTIFACT_LISTEN_ADDR":                   ":9091",
		"DEPLOYMENT_CREDENTIAL_SECRET_NAMESPACE": "agentflow-system",
		"DEPLOYMENT_CREDENTIAL_SECRET_NAME":      "provider-credentials",
		"POD_NAME":                               "agentflow-backend-abc",
	}
	getenv := func(key string) string { return base[key] }
	config, err := loadManagedDeploymentConfig(getenv, func() (string, error) { return "host", nil })
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.ControllerOwner != "agentflow-backend-abc" || config.Namespace != "agentflow-runtimes" {
		t.Fatalf("config = %+v", config)
	}
}

func TestLoadManagedDeploymentConfigDisabledWithoutClusterSettings(t *testing.T) {
	config, err := loadManagedDeploymentConfig(func(string) string { return "" }, func() (string, error) {
		return "", errors.New("must not be called")
	})
	if err != nil || config.Enabled {
		t.Fatalf("config/error = %+v/%v", config, err)
	}
}

func TestLoadManagedDeploymentConfigFailsClosed(t *testing.T) {
	_, err := loadManagedDeploymentConfig(func(key string) string {
		if key == "MANAGED_DEPLOYMENTS_ENABLED" {
			return "true"
		}
		return ""
	}, func() (string, error) { return "controller", nil })
	if err == nil {
		t.Fatal("missing required deployment settings accepted")
	}
	_, err = loadManagedDeploymentConfig(func(key string) string {
		if key == "MANAGED_DEPLOYMENTS_ENABLED" {
			return "yes"
		}
		return ""
	}, func() (string, error) { return "controller", nil })
	if err == nil {
		t.Fatal("ambiguous enable flag accepted")
	}
}
