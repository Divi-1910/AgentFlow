package repository_test

import (
	"context"
	"testing"

	"backend/agent"
	"backend/repository"
)

// testAgent returns a minimal valid agent.Agent for insertion.
func testAgent(name string) *agent.Agent {
	return &agent.Agent{
		Name:         name,
		Provider:     "openai",
		Model:        "gpt-4o",
		SystemPrompt: "You are helpful.",
		Tools:        []string{},
		MaxSteps:     5,
		MaxTokens:    1000,
		Temperature:  0.7,
	}
}

// agentRepo returns an AgentRepo with isolated collections for the calling test.
// The second (model) collection is empty; resolveContextLimit falls back gracefully.
func agentRepo(t *testing.T) *repository.AgentRepo {
	t.Helper()
	return repository.NewAgentRepo(col(t, "agents"), col(t, "models"))
}

const (
	userA = "507f1f77bcf86cd799439011"
	userB = "507f1f77bcf86cd799439022"
)

func TestAgentRepoCreateAndGetByID(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	created, err := r.Create(ctx, userA, testAgent("my-agent"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected non-empty ID")
	}
	if created.Name != "my-agent" {
		t.Errorf("Name: got %q, want %q", created.Name, "my-agent")
	}

	got, err := r.GetByID(ctx, created.ID, userA)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != created.ID {
		t.Errorf("ID mismatch: got %q, want %q", got.ID, created.ID)
	}
}

func TestAgentRepoGetByIDWrongUserReturnsNotFound(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	created, err := r.Create(ctx, userA, testAgent("owned"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	_, err = r.GetByID(ctx, created.ID, userB)
	if err == nil {
		t.Fatal("expected error for wrong user, got nil")
	}
	if err.Error() != "agent not found" {
		t.Errorf("err: got %q, want %q", err.Error(), "agent not found")
	}
}

func TestAgentRepoGetByIDSystemIgnoresUser(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	created, err := r.Create(ctx, userA, testAgent("sys-agent"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// GetByIDSystem should return the agent regardless of who created it.
	got, err := r.GetByIDSystem(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetByIDSystem: %v", err)
	}
	if got.ID != created.ID {
		t.Errorf("ID: got %q, want %q", got.ID, created.ID)
	}
}

func TestAgentRepoListByUserIsolation(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	for _, name := range []string{"agent1", "agent2"} {
		if _, err := r.Create(ctx, userA, testAgent(name)); err != nil {
			t.Fatalf("Create(%s): %v", name, err)
		}
	}
	if _, err := r.Create(ctx, userB, testAgent("other")); err != nil {
		t.Fatalf("Create(other): %v", err)
	}

	agents, err := r.ListByUser(ctx, userA)
	if err != nil {
		t.Fatalf("ListByUser: %v", err)
	}
	if len(agents) != 2 {
		t.Errorf("expected 2 agents for userA, got %d", len(agents))
	}

	agentsB, err := r.ListByUser(ctx, userB)
	if err != nil {
		t.Fatalf("ListByUser(B): %v", err)
	}
	if len(agentsB) != 1 {
		t.Errorf("expected 1 agent for userB, got %d", len(agentsB))
	}
}

func TestAgentRepoUpdate(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	created, err := r.Create(ctx, userA, testAgent("original"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	newName := "updated-name"
	updated, err := r.Update(ctx, created.ID, userA, agent.UpdateAgentInput{Name: &newName})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "updated-name" {
		t.Errorf("Name: got %q, want %q", updated.Name, "updated-name")
	}
}

func TestAgentRepoUpdateNotFound(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	created, err := r.Create(ctx, userA, testAgent("mine"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	newName := "hacked"
	_, err = r.Update(ctx, created.ID, userB, agent.UpdateAgentInput{Name: &newName})
	if err == nil {
		t.Fatal("expected error for wrong user, got nil")
	}
	if err.Error() != "agent not found" {
		t.Errorf("err: got %q, want %q", err.Error(), "agent not found")
	}
}

func TestAgentRepoDeleteRemovesDocument(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	created, err := r.Create(ctx, userA, testAgent("to-delete"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := r.Delete(ctx, created.ID, userA); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err = r.GetByID(ctx, created.ID, userA)
	if err == nil {
		t.Fatal("expected error after delete, got nil")
	}
	if err.Error() != "agent not found" {
		t.Errorf("err: got %q, want %q", err.Error(), "agent not found")
	}
}

func TestAgentRepoDeleteNotFoundReturnsError(t *testing.T) {
	r := agentRepo(t)
	ctx := context.Background()

	err := r.Delete(ctx, "507f1f77bcf86cd799439099", userA)
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
	if err.Error() != "agent not found" {
		t.Errorf("err: got %q, want %q", err.Error(), "agent not found")
	}
}
