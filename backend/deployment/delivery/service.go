// Package delivery owns the narrow capability used by an AgentFlow init
// container to download one immutable deployment bundle. It deliberately does
// not reuse Studio user sessions or runtime API credentials.
package delivery

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"backend/deployment"
)

const (
	TokenPrefix      = "afdt_"
	TokenEntropySize = 32
	DefaultTokenTTL  = 24 * time.Hour
	MaximumTokenTTL  = 7 * 24 * time.Hour
	MaxTokenIDBytes  = 128
	createAttempts   = 3
)

var (
	// ErrUnauthorized is intentionally the only authorization failure exposed
	// to the HTTP boundary. Callers must not learn whether a token was unknown,
	// expired, revoked, or valid for a different scope.
	ErrUnauthorized = errors.New("deployment delivery: unauthorized")
	ErrInvalidIssue = errors.New("deployment delivery: invalid issue request")

	// Store errors let adapters communicate expected lookup/collision outcomes
	// without exposing storage-specific errors to the application service.
	ErrGrantNotFound     = errors.New("deployment delivery: grant not found")
	ErrTokenHashConflict = errors.New("deployment delivery: token hash conflict")
)

type Grant struct {
	ID                 string
	TokenHash          string
	UserID             string
	DeploymentID       string
	Generation         int64
	Revision           int
	ConfigHash         string
	SchemaVersion      int
	CreatedAt          time.Time
	ExpiresAt          time.Time
	RevokedAt          *time.Time
	LastAuthorizedAt   *time.Time
	AuthorizationCount int64
}

type Credential struct {
	Token         string
	TokenID       string
	UserID        string
	DeploymentID  string
	Generation    int64
	Revision      int
	ConfigHash    string
	SchemaVersion int
	ExpiresAt     time.Time
}

type IssueRequest struct {
	UserID       string
	DeploymentID string
	Generation   int64
}

type AuthorizeRequest struct {
	Token        string
	DeploymentID string
	Generation   int64
	Revision     int
}

type AuthorizedBundle struct {
	TokenID  string
	Revision deployment.Revision
}

type Store interface {
	Create(ctx context.Context, grant Grant) (*Grant, error)
	FindByHash(ctx context.Context, tokenHash string) (*Grant, error)
	RecordAuthorization(ctx context.Context, grantID string, authorizedAt time.Time) error
	RevokeGeneration(ctx context.Context, userID, deploymentID string, generation int64, revokedAt time.Time) error
}

type StateReader interface {
	Get(ctx context.Context, userID, deploymentID string) (*deployment.DeployState, error)
}

type RevisionReader interface {
	Get(ctx context.Context, userID, deploymentID string, revision int) (*deployment.Revision, error)
}

type Config struct {
	Tokens    Store
	States    StateReader
	Revisions RevisionReader
	TokenTTL  time.Duration
	Now       func() time.Time
	Random    io.Reader
}

type Service struct {
	tokens    Store
	states    StateReader
	revisions RevisionReader
	tokenTTL  time.Duration
	now       func() time.Time
	random    io.Reader
}

func NewService(cfg Config) (*Service, error) {
	if cfg.Tokens == nil || cfg.States == nil || cfg.Revisions == nil {
		return nil, errors.New("deployment delivery: token, state, and revision stores are required")
	}
	ttl := cfg.TokenTTL
	if ttl == 0 {
		ttl = DefaultTokenTTL
	}
	if ttl <= 0 || ttl > MaximumTokenTTL {
		return nil, fmt.Errorf("deployment delivery: token TTL must be positive and at most %s", MaximumTokenTTL)
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	random := cfg.Random
	if random == nil {
		random = rand.Reader
	}
	return &Service{
		tokens: cfg.Tokens, states: cfg.States, revisions: cfg.Revisions,
		tokenTTL: ttl, now: now, random: random,
	}, nil
}

// Issue creates a new credential for the currently desired run generation.
// Revision, hash, and schema are derived from durable state rather than trusted
// from the caller, preventing a controller bug from minting a broader token.
func (s *Service) Issue(ctx context.Context, request IssueRequest) (*Credential, error) {
	if strings.TrimSpace(request.UserID) == "" || strings.TrimSpace(request.DeploymentID) == "" || request.Generation <= 0 {
		return nil, ErrInvalidIssue
	}

	state, err := s.states.Get(ctx, request.UserID, request.DeploymentID)
	if err != nil {
		return nil, fmt.Errorf("deployment delivery: load desired state: %w", err)
	}
	if state == nil || state.UserID != request.UserID || state.DeploymentID != request.DeploymentID ||
		state.Desired.Generation != request.Generation || state.Desired.Action != deployment.DesiredActionRun {
		return nil, ErrInvalidIssue
	}
	target := state.Desired.Target
	if err := deployment.ValidateDeploymentTarget(target); err != nil {
		return nil, fmt.Errorf("%w: desired target: %v", ErrInvalidIssue, err)
	}

	revision, err := s.revisions.Get(ctx, request.UserID, request.DeploymentID, target.Revision)
	if err != nil {
		return nil, fmt.Errorf("deployment delivery: load revision: %w", err)
	}
	if !revisionMatches(revision, request.UserID, request.DeploymentID, target) {
		return nil, fmt.Errorf("%w: desired target does not match immutable revision", ErrInvalidIssue)
	}

	now := s.now().UTC()
	for attempt := 0; attempt < createAttempts; attempt++ {
		token, err := newToken(s.random)
		if err != nil {
			return nil, err
		}
		tokenHash := hashToken(token)
		grant, err := s.tokens.Create(ctx, Grant{
			TokenHash: tokenHash, UserID: request.UserID, DeploymentID: request.DeploymentID,
			Generation: request.Generation, Revision: target.Revision, ConfigHash: target.ConfigHash,
			SchemaVersion: target.SchemaVersion, CreatedAt: now, ExpiresAt: now.Add(s.tokenTTL),
		})
		if errors.Is(err, ErrTokenHashConflict) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("deployment delivery: persist grant: %w", err)
		}
		if grant == nil || !validBoundedVisibleASCII(grant.ID, MaxTokenIDBytes) || grant.TokenHash != tokenHash ||
			grant.UserID != request.UserID || grant.DeploymentID != request.DeploymentID ||
			grant.Generation != request.Generation || grant.Revision != target.Revision ||
			grant.ConfigHash != target.ConfigHash || grant.SchemaVersion != target.SchemaVersion ||
			grant.RevokedAt != nil || !now.Before(grant.ExpiresAt) || grant.ExpiresAt.After(now.Add(s.tokenTTL)) {
			return nil, errors.New("deployment delivery: token store returned an invalid grant")
		}
		return &Credential{
			Token: token, TokenID: grant.ID, UserID: grant.UserID, DeploymentID: grant.DeploymentID,
			Generation: grant.Generation, Revision: grant.Revision, ConfigHash: grant.ConfigHash,
			SchemaVersion: grant.SchemaVersion, ExpiresAt: grant.ExpiresAt,
		}, nil
	}
	return nil, fmt.Errorf("deployment delivery: allocate unique token after %d attempts", createAttempts)
}

// Authorize verifies both the capability and the current desired generation.
// A stored grant alone is insufficient: changing or deleting desired state
// immediately makes an otherwise unexpired credential unusable.
func (s *Service) Authorize(ctx context.Context, request AuthorizeRequest) (*AuthorizedBundle, error) {
	if validateToken(request.Token) != nil || strings.TrimSpace(request.DeploymentID) == "" ||
		request.Generation <= 0 || request.Revision <= 0 {
		return nil, ErrUnauthorized
	}

	tokenHash := hashToken(request.Token)
	grant, err := s.tokens.FindByHash(ctx, tokenHash)
	if errors.Is(err, ErrGrantNotFound) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, fmt.Errorf("deployment delivery: find grant: %w", err)
	}
	now := s.now().UTC()
	if grant == nil || !validBoundedVisibleASCII(grant.ID, MaxTokenIDBytes) || grant.TokenHash != tokenHash ||
		grant.RevokedAt != nil || !now.Before(grant.ExpiresAt) ||
		grant.DeploymentID != request.DeploymentID || grant.Generation != request.Generation || grant.Revision != request.Revision {
		return nil, ErrUnauthorized
	}

	state, err := s.states.Get(ctx, grant.UserID, grant.DeploymentID)
	if errors.Is(err, deployment.ErrDeployStateNotFound) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, fmt.Errorf("deployment delivery: load desired state: %w", err)
	}
	if !grantMatchesState(grant, state) {
		return nil, ErrUnauthorized
	}

	revision, err := s.revisions.Get(ctx, grant.UserID, grant.DeploymentID, grant.Revision)
	if errors.Is(err, deployment.ErrRevisionNotFound) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, fmt.Errorf("deployment delivery: load revision: %w", err)
	}
	if !revisionMatches(revision, grant.UserID, grant.DeploymentID, state.Desired.Target) {
		return nil, ErrUnauthorized
	}
	if err := s.tokens.RecordAuthorization(ctx, grant.ID, now); errors.Is(err, ErrGrantNotFound) {
		return nil, ErrUnauthorized
	} else if err != nil {
		return nil, fmt.Errorf("deployment delivery: record authorization: %w", err)
	}

	copy := *revision
	copy.BundleJSON = append([]byte(nil), revision.BundleJSON...)
	return &AuthorizedBundle{TokenID: grant.ID, Revision: copy}, nil
}

func (s *Service) RevokeGeneration(ctx context.Context, userID, deploymentID string, generation int64) error {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(deploymentID) == "" || generation <= 0 {
		return ErrInvalidIssue
	}
	if err := s.tokens.RevokeGeneration(ctx, userID, deploymentID, generation, s.now().UTC()); err != nil {
		return fmt.Errorf("deployment delivery: revoke generation: %w", err)
	}
	return nil
}

func newToken(random io.Reader) (string, error) {
	raw := make([]byte, TokenEntropySize)
	if _, err := io.ReadFull(random, raw); err != nil {
		return "", fmt.Errorf("deployment delivery: generate token: %w", err)
	}
	return TokenPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func validateToken(token string) error {
	if !strings.HasPrefix(token, TokenPrefix) {
		return ErrUnauthorized
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, TokenPrefix))
	if err != nil || len(raw) != TokenEntropySize {
		return ErrUnauthorized
	}
	return nil
}

func hashToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func validBoundedVisibleASCII(value string, maximum int) bool {
	if len(value) == 0 || len(value) > maximum {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return false
		}
	}
	return true
}

func grantMatchesState(grant *Grant, state *deployment.DeployState) bool {
	if grant == nil || state == nil || state.UserID != grant.UserID || state.DeploymentID != grant.DeploymentID ||
		state.Desired.Action != deployment.DesiredActionRun || state.Desired.Generation != grant.Generation {
		return false
	}
	target := state.Desired.Target
	return target.Revision == grant.Revision && target.ConfigHash == grant.ConfigHash && target.SchemaVersion == grant.SchemaVersion
}

func revisionMatches(revision *deployment.Revision, userID, deploymentID string, target deployment.DeploymentTarget) bool {
	return revision != nil && revision.UserID == userID && revision.DeploymentID == deploymentID &&
		revision.Revision == target.Revision && revision.ConfigHash == target.ConfigHash &&
		revision.SchemaVersion == target.SchemaVersion && len(revision.BundleJSON) > 0 &&
		len(revision.BundleJSON) <= deployment.MaxBundleBytes
}
