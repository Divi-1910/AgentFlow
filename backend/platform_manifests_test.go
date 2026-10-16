package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/yaml"
)

func TestPlatformManifestsDecodeAndDoNotContainSecrets(t *testing.T) {
	paths, err := filepath.Glob("../deploy/kubernetes/[0-9][0-9]-*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 5 {
		t.Fatalf("numbered platform manifests = %d, want 5", len(paths))
	}
	objects := 0
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		decoder := yaml.NewYAMLOrJSONDecoder(file, 4096)
		for {
			var object unstructured.Unstructured
			err := decoder.Decode(&object)
			if err == io.EOF {
				break
			}
			if err != nil {
				_ = file.Close()
				t.Fatalf("decode %s: %v", path, err)
			}
			if object.GetKind() == "" || object.GetAPIVersion() == "" || object.GetName() == "" {
				_ = file.Close()
				t.Fatalf("%s contains object without apiVersion/kind/name: %+v", path, object.Object)
			}
			if object.GetKind() == "Secret" {
				_ = file.Close()
				t.Fatalf("deployable platform manifest %s embeds a Secret", path)
			}
			objects++
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if objects < 10 {
		t.Fatalf("decoded only %d platform objects", objects)
	}
}
