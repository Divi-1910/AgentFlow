// Package integration contains end-to-end HTTP integration tests for the
// graas_agent backend. Each test spins up a real httptest.Server wired to an
// isolated MongoDB collection set, so the full HTTP → handler → repository
// stack is exercised without any fakes in the persistence layer.
package integration
