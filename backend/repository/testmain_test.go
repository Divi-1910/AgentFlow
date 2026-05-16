package repository_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var testDB *mongo.Database

func TestMain(m *testing.M) {
	uri := os.Getenv("MONGO_TEST_URI")
	if uri == "" {
		uri = "mongodb://localhost:27017"
	}

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		panic("failed to connect to MongoDB: " + err.Error())
	}

	testDB = client.Database("TestDB")

	// Clean start — handles leftover state from a prior crashed run.
	if err := testDB.Drop(context.Background()); err != nil {
		panic("failed to drop TestDB at start: " + err.Error())
	}

	code := m.Run()

	// Clean end.
	_ = testDB.Drop(context.Background())
	_ = client.Disconnect(context.Background())

	os.Exit(code)
}

// col returns an isolated collection for the calling test.
// The collection name is "prefix_TestFunctionName" so each test gets its own
// namespace. It is automatically dropped when the test ends.
func col(t *testing.T, prefix string) *mongo.Collection {
	t.Helper()
	c := testDB.Collection(prefix + "_" + sanitize(t.Name()))
	t.Cleanup(func() {
		_ = c.Drop(context.Background())
	})
	return c
}

func sanitize(s string) string {
	r := strings.NewReplacer("/", "_", ":", "_", " ", "_")
	return r.Replace(s)
}
