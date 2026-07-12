package mongorepo_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"

	"backend/deployment"
	"backend/repo/mongorepo"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func deploymentRevisionRepo(t *testing.T) *mongorepo.DeploymentRevisionRepo {
	t.Helper()
	r := mongorepo.NewDeploymentRevisionRepo(col(t, "deployment_revisions"))
	if err := r.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	return r
}

func revisionHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func revisionInput(hash, body string) deployment.RevisionInput {
	return deployment.RevisionInput{
		UserID: userA, DeploymentID: "507f1f77bcf86cd799439099", RootAgentID: "507f1f77bcf86cd799439099",
		ConfigHash: hash, SchemaVersion: deployment.SchemaVersion, BundleJSON: []byte(body),
	}
}

func TestDeploymentRevisionAppendReplayAndIncrement(t *testing.T) {
	r := deploymentRevisionRepo(t)
	ctx := context.Background()
	firstInput := revisionInput(revisionHash("first"), `{"revision":1}`)
	first, existing, err := r.Append(ctx, firstInput)
	if err != nil || existing || first.Revision != 1 {
		t.Fatalf("first = %+v existing=%v err=%v", first, existing, err)
	}
	replay, existing, err := r.Append(ctx, firstInput)
	if err != nil || !existing || replay.Revision != 1 || !replay.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("replay = %+v existing=%v err=%v", replay, existing, err)
	}
	second, existing, err := r.Append(ctx, revisionInput(revisionHash("second"), `{"revision":2}`))
	if err != nil || existing || second.Revision != 2 {
		t.Fatalf("second = %+v existing=%v err=%v", second, existing, err)
	}
	listed, err := r.List(ctx, userA, first.DeploymentID, 1)
	if err != nil || len(listed) != 1 || listed[0].Revision != 2 || listed[0].BundleJSON != nil {
		t.Fatalf("List = %+v err=%v", listed, err)
	}

	first.BundleJSON[0] = 'x'
	loaded, err := r.Get(ctx, userA, first.DeploymentID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if string(loaded.BundleJSON) != string(firstInput.BundleJSON) {
		t.Fatalf("stored bytes mutated: %q", loaded.BundleJSON)
	}
	loaded.BundleJSON[0] = 'y'
	again, _ := r.Get(ctx, userA, first.DeploymentID, 1)
	if string(again.BundleJSON) != string(firstInput.BundleJSON) {
		t.Fatalf("Get returned shared bytes: %q", again.BundleJSON)
	}
}

func TestDeploymentRevisionConcurrentIdenticalConverges(t *testing.T) {
	r := deploymentRevisionRepo(t)
	input := revisionInput(revisionHash("same"), `{"same":true}`)
	const workers = 20
	var wg sync.WaitGroup
	revisions := make(chan int, workers)
	newCount := make(chan bool, workers)
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rev, existing, err := r.Append(context.Background(), input)
			if err == nil {
				revisions <- rev.Revision
				newCount <- !existing
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(revisions)
	close(newCount)
	close(errs)
	created := 0
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for revision := range revisions {
		if revision != 1 {
			t.Fatalf("revision = %d, want 1", revision)
		}
	}
	for wasNew := range newCount {
		if wasNew {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("new revision results = %d, want 1", created)
	}
}

func TestDeploymentRevisionConcurrentDistinctAllocatesUniqueRevisions(t *testing.T) {
	r := deploymentRevisionRepo(t)
	const workers = 8
	var wg sync.WaitGroup
	revisions := make(chan int, workers)
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			value := fmt.Sprintf("config-%d", i)
			rev, existing, err := r.Append(context.Background(), revisionInput(revisionHash(value), value))
			if err == nil {
				if existing {
					err = fmt.Errorf("distinct config reported existing")
				} else {
					revisions <- rev.Revision
				}
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(revisions)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	got := make([]int, 0, workers)
	for revision := range revisions {
		got = append(got, revision)
	}
	sort.Ints(got)
	for i, revision := range got {
		if revision != i+1 {
			t.Fatalf("revisions = %v", got)
		}
	}
}

func TestDeploymentRevisionOwnerScopeAndValidation(t *testing.T) {
	r := deploymentRevisionRepo(t)
	input := revisionInput(revisionHash("owner"), `{"owner":true}`)
	if _, _, err := r.Append(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(context.Background(), userB, input.DeploymentID, 1); !errors.Is(err, deployment.ErrRevisionNotFound) {
		t.Fatalf("cross-owner Get = %v", err)
	}
	if _, err := r.Get(context.Background(), userA, input.DeploymentID, 0); !errors.Is(err, deployment.ErrRevisionNotFound) {
		t.Fatalf("invalid revision Get = %v", err)
	}
	otherOwner := input
	otherOwner.UserID = userB
	if revision, existing, err := r.Append(context.Background(), otherOwner); err != nil || existing || revision.Revision != 1 {
		t.Fatalf("same deployment id for another owner = %+v existing=%v err=%v", revision, existing, err)
	}
	if listed, err := r.List(context.Background(), userB, input.DeploymentID, 10); err != nil || len(listed) != 1 || listed[0].UserID != userB {
		t.Fatalf("owner-scoped List = %+v err=%v", listed, err)
	}

	cases := []deployment.RevisionInput{
		{},
		revisionInput("bad", `{}`),
		revisionInput(revisionHash("empty"), ""),
		revisionInput(revisionHash("large"), string(make([]byte, deployment.MaxBundleBytes+1))),
	}
	for i, tc := range cases {
		if _, _, err := r.Append(context.Background(), tc); err == nil {
			t.Fatalf("invalid case %d succeeded", i)
		}
	}
}

func TestDeploymentRevisionIndexes(t *testing.T) {
	collection := col(t, "deployment_revisions")
	r := mongorepo.NewDeploymentRevisionRepo(collection)
	ctx := context.Background()
	if _, err := collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "deployment_id", Value: 1}, {Key: "revision", Value: 1}}, Options: options.Index().SetUnique(true).SetName("deployment_revisions_revision_unique")},
		{Keys: bson.D{{Key: "deployment_id", Value: 1}, {Key: "config_hash", Value: 1}}, Options: options.Index().SetUnique(true).SetName("deployment_revisions_hash_unique")},
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	cursor, err := collection.Indexes().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cursor.Close(ctx)
	var indexes []struct {
		Name   string `bson:"name"`
		Key    bson.D `bson:"key"`
		Unique bool   `bson:"unique"`
	}
	if err := cursor.All(ctx, &indexes); err != nil {
		t.Fatal(err)
	}
	byName := make(map[string]struct {
		keys   bson.D
		unique bool
	}, len(indexes))
	for _, index := range indexes {
		byName[index.Name] = struct {
			keys   bson.D
			unique bool
		}{index.Key, index.Unique}
	}
	for _, name := range []string{"deployment_revisions_owner_revision_unique", "deployment_revisions_owner_hash_unique"} {
		index, ok := byName[name]
		if !ok {
			t.Fatalf("missing index %q in %v", name, byName)
		}
		if !index.unique || len(index.keys) != 3 || index.keys[0].Key != "user_id" || index.keys[1].Key != "deployment_id" {
			t.Fatalf("index %q = %+v", name, index)
		}
	}
	for _, legacy := range []string{"deployment_revisions_revision_unique", "deployment_revisions_hash_unique"} {
		if _, ok := byName[legacy]; ok {
			t.Fatalf("legacy deployment-global index %q remains", legacy)
		}
	}
}

func TestDeploymentRevisionAcceptsExactBundleSizeLimit(t *testing.T) {
	r := deploymentRevisionRepo(t)
	input := revisionInput(revisionHash("exact-limit"), "placeholder")
	input.BundleJSON = make([]byte, deployment.MaxBundleBytes)
	revision, existing, err := r.Append(context.Background(), input)
	if err != nil || existing || len(revision.BundleJSON) != deployment.MaxBundleBytes {
		t.Fatalf("Append exact limit: revision=%v existing=%v err=%v", revision, existing, err)
	}
}
