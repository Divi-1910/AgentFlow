package tools_test

import (
	"reflect"
	"testing"

	"backend/tools"
)

func TestCredentialEnvNames(t *testing.T) {
	t.Parallel()

	got := tools.CredentialEnvNames("web_search")
	want := []string{"TAVILY_API_KEY"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CredentialEnvNames(web_search) = %v, want %v", got, want)
	}

	got[0] = "MUTATED"
	if reflect.DeepEqual(tools.CredentialEnvNames("web_search"), got) {
		t.Fatal("CredentialEnvNames returned shared storage")
	}
	if names := tools.CredentialEnvNames("calculator"); len(names) != 0 {
		t.Fatalf("CredentialEnvNames(calculator) = %v, want empty", names)
	}
}
