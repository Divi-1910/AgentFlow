package main

import "testing"

func TestManagedStorageContextFromFlags(t *testing.T) {
	tests := []struct {
		name               string
		isManaged          bool
		storageID          string
		deploymentID       string
		revision           int
		generation         int64
		expectedConfigHash string
		wantContext        bool
		wantError          bool
	}{
		{name: "standalone", wantContext: false},
		{name: "managed", isManaged: true, storageID: "storage", deploymentID: "deployment", revision: 1, generation: 2, expectedConfigHash: "hash", wantContext: true},
		{name: "managed values without mode", storageID: "storage", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, err := managedStorageContextFromFlags(
				test.isManaged,
				test.storageID,
				test.deploymentID,
				test.revision,
				test.generation,
				test.expectedConfigHash,
			)
			if (err != nil) != test.wantError {
				t.Fatalf("error = %v, wantError %t", err, test.wantError)
			}
			if (context != nil) != test.wantContext {
				t.Fatalf("context present = %t, want %t", context != nil, test.wantContext)
			}
		})
	}
}
