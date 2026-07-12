package deployment_test

import (
	"strings"
	"testing"

	"backend/deployment"
)

func TestResourceNameUsesImmutablePublicationIdentity(t *testing.T) {
	hash := strings.Repeat("a", 64)
	got, err := deployment.ResourceName("507F1F77-BCF86CD799439099", 12, hash)
	if err != nil {
		t.Fatal(err)
	}
	if got != "af-507f1f77-bcf86cd799439099-r12-aaaaaaaaaaaa" || len(got) > 63 {
		t.Fatalf("ResourceName = %q", got)
	}
	changedRevision, _ := deployment.ResourceName("507F1F77-BCF86CD799439099", 13, hash)
	changedHash, _ := deployment.ResourceName("507F1F77-BCF86CD799439099", 12, strings.Repeat("b", 64))
	if changedRevision == got || changedHash == got {
		t.Fatal("resource name did not change with revision/hash")
	}
}

func TestResourceNameBoundsAndValidation(t *testing.T) {
	got, err := deployment.ResourceName(strings.Repeat("LONG_name.", 20), 1, strings.Repeat("c", 64))
	if err != nil || len(got) > 63 || strings.HasSuffix(got, "-") {
		t.Fatalf("ResourceName = %q err=%v", got, err)
	}
	for _, tc := range []struct {
		id       string
		revision int
		hash     string
	}{{"", 1, strings.Repeat("a", 64)}, {"id", 0, strings.Repeat("a", 64)}, {"id", 1, "bad"}} {
		if _, err := deployment.ResourceName(tc.id, tc.revision, tc.hash); err == nil {
			t.Fatalf("ResourceName(%q, %d, %q) succeeded", tc.id, tc.revision, tc.hash)
		}
	}
}
