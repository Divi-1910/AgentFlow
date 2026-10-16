package delivery_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"backend/deployment"
	"backend/deployment/delivery"
)

const testImage = "registry.example/agentflow-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type fakeTokenStore struct {
	grants         map[string]*delivery.Grant
	authorizations int
	revocations    int
}

func (s *fakeTokenStore) Create(_ context.Context, grant delivery.Grant) (*delivery.Grant, error) {
	if s.grants == nil {
		s.grants = make(map[string]*delivery.Grant)
	}
	if _, exists := s.grants[grant.TokenHash]; exists {
		return nil, delivery.ErrTokenHashConflict
	}
	grant.ID = "grant-1"
	copy := grant
	s.grants[grant.TokenHash] = &copy
	return &copy, nil
}

func (s *fakeTokenStore) FindByHash(_ context.Context, tokenHash string) (*delivery.Grant, error) {
	grant := s.grants[tokenHash]
	if grant == nil {
		return nil, delivery.ErrGrantNotFound
	}
	copy := *grant
	return &copy, nil
}

func (s *fakeTokenStore) RecordAuthorization(_ context.Context, grantID string, authorizedAt time.Time) error {
	if grantID != "grant-1" || authorizedAt.IsZero() {
		return errors.New("unexpected authorization record")
	}
	s.authorizations++
	return nil
}

func (s *fakeTokenStore) RevokeGeneration(_ context.Context, userID, deploymentID string, generation int64, revokedAt time.Time) error {
	for _, grant := range s.grants {
		if grant.UserID == userID && grant.DeploymentID == deploymentID && grant.Generation == generation {
			when := revokedAt
			grant.RevokedAt = &when
			s.revocations++
		}
	}
	return nil
}

type fakeStateReader struct {
	state *deployment.DeployState
	err   error
}

func (r *fakeStateReader) Get(context.Context, string, string) (*deployment.DeployState, error) {
	if r.err != nil {
		return nil, r.err
	}
	if r.state == nil {
		return nil, deployment.ErrDeployStateNotFound
	}
	copy := *r.state
	return &copy, nil
}

type fakeRevisionReader struct {
	revision *deployment.Revision
	err      error
}

func (r *fakeRevisionReader) Get(context.Context, string, string, int) (*deployment.Revision, error) {
	if r.err != nil {
		return nil, r.err
	}
	if r.revision == nil {
		return nil, deployment.ErrRevisionNotFound
	}
	copy := *r.revision
	copy.BundleJSON = append([]byte(nil), r.revision.BundleJSON...)
	return &copy, nil
}

func TestIssueAndAuthorizeExactCurrentGeneration(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 4, 5, 6, 0, time.UTC)
	state, revision := deliveryFixture()
	tokens := &fakeTokenStore{}
	service := newDeliveryService(t, tokens, state, revision, now)

	credential, err := service.Issue(context.Background(), delivery.IssueRequest{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(credential.Token, delivery.TokenPrefix) || credential.TokenID != "grant-1" {
		t.Fatalf("credential = %+v", credential)
	}
	if !credential.ExpiresAt.Equal(now.Add(delivery.DefaultTokenTTL)) {
		t.Fatalf("expiry = %s", credential.ExpiresAt)
	}

	authorized, err := service.Authorize(context.Background(), delivery.AuthorizeRequest{
		Token: credential.Token, DeploymentID: state.DeploymentID,
		Generation: state.Desired.Generation, Revision: state.Desired.Target.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if authorized.TokenID != credential.TokenID || !bytes.Equal(authorized.Revision.BundleJSON, revision.BundleJSON) {
		t.Fatalf("authorized = %+v", authorized)
	}
	if tokens.authorizations != 1 {
		t.Fatalf("authorization records = %d, want 1", tokens.authorizations)
	}
}

func TestAuthorizeRejectsCredentialWhenDesiredGenerationChanges(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 4, 5, 6, 0, time.UTC)
	state, revision := deliveryFixture()
	tokens := &fakeTokenStore{}
	service := newDeliveryService(t, tokens, state, revision, now)
	credential, err := service.Issue(context.Background(), delivery.IssueRequest{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
	})
	if err != nil {
		t.Fatal(err)
	}

	state.Desired.Generation++
	_, err = service.Authorize(context.Background(), delivery.AuthorizeRequest{
		Token: credential.Token, DeploymentID: credential.DeploymentID,
		Generation: credential.Generation, Revision: credential.Revision,
	})
	if !errors.Is(err, delivery.ErrUnauthorized) {
		t.Fatalf("authorize error = %v", err)
	}
	if tokens.authorizations != 0 {
		t.Fatal("stale credential was recorded as authorized")
	}
}

func TestAuthorizeReturnsSameGenericErrorForInvalidCapabilities(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 4, 5, 6, 0, time.UTC)
	state, revision := deliveryFixture()
	tokens := &fakeTokenStore{}
	service := newDeliveryService(t, tokens, state, revision, now)
	credential, err := service.Issue(context.Background(), delivery.IssueRequest{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
	})
	if err != nil {
		t.Fatal(err)
	}

	grant := onlyGrant(t, tokens)
	expired := now
	grant.ExpiresAt = expired
	tests := []delivery.AuthorizeRequest{
		{Token: "not-a-token", DeploymentID: credential.DeploymentID, Generation: credential.Generation, Revision: credential.Revision},
		{Token: credential.Token, DeploymentID: "other-deployment", Generation: credential.Generation, Revision: credential.Revision},
		{Token: credential.Token, DeploymentID: credential.DeploymentID, Generation: credential.Generation + 1, Revision: credential.Revision},
		{Token: credential.Token, DeploymentID: credential.DeploymentID, Generation: credential.Generation, Revision: credential.Revision + 1},
		{Token: credential.Token, DeploymentID: credential.DeploymentID, Generation: credential.Generation, Revision: credential.Revision},
	}
	for _, request := range tests {
		if _, err := service.Authorize(context.Background(), request); !errors.Is(err, delivery.ErrUnauthorized) {
			t.Fatalf("request %+v error = %v", request, err)
		}
	}
}

func TestRevokeGenerationInvalidatesCredential(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 4, 5, 6, 0, time.UTC)
	state, revision := deliveryFixture()
	tokens := &fakeTokenStore{}
	service := newDeliveryService(t, tokens, state, revision, now)
	credential, err := service.Issue(context.Background(), delivery.IssueRequest{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeGeneration(context.Background(), state.UserID, state.DeploymentID, state.Desired.Generation); err != nil {
		t.Fatal(err)
	}
	_, err = service.Authorize(context.Background(), delivery.AuthorizeRequest{
		Token: credential.Token, DeploymentID: credential.DeploymentID,
		Generation: credential.Generation, Revision: credential.Revision,
	})
	if !errors.Is(err, delivery.ErrUnauthorized) || tokens.revocations != 1 {
		t.Fatalf("authorize error = %v revocations=%d", err, tokens.revocations)
	}
}

func TestIssueRejectsStaleOrDeletedGeneration(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 4, 5, 6, 0, time.UTC)
	state, revision := deliveryFixture()
	service := newDeliveryService(t, &fakeTokenStore{}, state, revision, now)
	for _, generation := range []int64{0, state.Desired.Generation + 1} {
		_, err := service.Issue(context.Background(), delivery.IssueRequest{
			UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: generation,
		})
		if !errors.Is(err, delivery.ErrInvalidIssue) {
			t.Fatalf("generation %d error = %v", generation, err)
		}
	}
	state.Desired.Action = deployment.DesiredActionDelete
	_, err := service.Issue(context.Background(), delivery.IssueRequest{
		UserID: state.UserID, DeploymentID: state.DeploymentID, Generation: state.Desired.Generation,
	})
	if !errors.Is(err, delivery.ErrInvalidIssue) {
		t.Fatalf("deleted generation error = %v", err)
	}
}

func TestNewServiceRejectsUnsafeTTL(t *testing.T) {
	t.Parallel()
	state, revision := deliveryFixture()
	_, err := delivery.NewService(delivery.Config{
		Tokens: &fakeTokenStore{}, States: &fakeStateReader{state: state}, Revisions: &fakeRevisionReader{revision: revision},
		TokenTTL: delivery.MaximumTokenTTL + time.Second,
	})
	if err == nil {
		t.Fatal("NewService accepted an excessive token TTL")
	}
}

func newDeliveryService(t *testing.T, tokens *fakeTokenStore, state *deployment.DeployState, revision *deployment.Revision, now time.Time) *delivery.Service {
	t.Helper()
	service, err := delivery.NewService(delivery.Config{
		Tokens: tokens, States: &fakeStateReader{state: state}, Revisions: &fakeRevisionReader{revision: revision},
		Now: func() time.Time { return now }, Random: bytes.NewReader(bytes.Repeat([]byte{0x5a}, delivery.TokenEntropySize*8)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func deliveryFixture() (*deployment.DeployState, *deployment.Revision) {
	userID := "507f1f77bcf86cd799439011"
	deploymentID := "507f1f77bcf86cd799439012"
	target := deployment.DeploymentTarget{
		Revision: 7, ConfigHash: strings.Repeat("a", 64), SchemaVersion: deployment.SchemaVersion,
		Namespace: "agentflow-runtimes", RuntimeImage: testImage,
	}
	state := &deployment.DeployState{
		RecordVersion: deployment.DeployStateRecordVersion, UserID: userID, DeploymentID: deploymentID,
		Desired: deployment.DesiredState{Generation: 4, Action: deployment.DesiredActionRun, Target: target},
	}
	revision := &deployment.Revision{
		UserID: userID, DeploymentID: deploymentID, RootAgentID: deploymentID,
		Revision: target.Revision, ConfigHash: target.ConfigHash, SchemaVersion: target.SchemaVersion,
		BundleJSON: []byte(`{"schema_version":1}`),
	}
	return state, revision
}

func onlyGrant(t *testing.T, tokens *fakeTokenStore) *delivery.Grant {
	t.Helper()
	for _, grant := range tokens.grants {
		return grant
	}
	t.Fatal("grant not found")
	return nil
}
