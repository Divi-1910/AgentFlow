package dispatcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/llm"
	"backend/runtimectx"

	"github.com/google/uuid"
)

const (
	defaultDelegateSafetyTimeout = 30 * time.Minute
)

var (
	ErrDelegationDepthExceeded = errors.New("delegation depth exceeded")
	ErrDelegationCycle         = errors.New("delegation cycle detected")
	ErrDelegateNotOwned        = errors.New("delegate agent not found or not owned by this user")
)

// BusDelegateInvoker runs a delegated agent by dispatching it through the bus
// (the same path top-level runs use) and awaiting its reply. It owns the
// delegate preflight — depth/cycle/ownership guards, sub-thread resolution,
// child-run creation — but does NOT publish cancel on the normal path (the
// top-level dispatcher's cancel cascade governs the tree) and does NOT touch a
// child run's status once it has been dispatched (the worker/runtime own it).
type BusDelegateInvoker struct {
	bus           bus.MessageBus
	pools         *PoolManager
	agents        AgentStore
	threads       ThreadStore
	runs          RunStore
	messages      MessageStore
	tasks         taskBudgetStore
	maxDepth      int
	safetyTimeout time.Duration
}

type BusDelegateInvokerConfig struct {
	Bus           bus.MessageBus
	Pools         *PoolManager
	Agents        AgentStore
	Threads       ThreadStore
	Runs          RunStore
	Messages      MessageStore
	Tasks         taskBudgetStore
	MaxDepth      int
	SafetyTimeout time.Duration
}

func NewBusDelegateInvoker(cfg BusDelegateInvokerConfig) *BusDelegateInvoker {
	maxDepth := cfg.MaxDepth
	if maxDepth <= 0 {
		maxDepth = agent.DefaultMaxDelegationDepth
	}
	safety := cfg.SafetyTimeout
	if safety <= 0 {
		safety = defaultDelegateSafetyTimeout
	}
	return &BusDelegateInvoker{
		bus:           cfg.Bus,
		pools:         cfg.Pools,
		agents:        cfg.Agents,
		threads:       cfg.Threads,
		runs:          cfg.Runs,
		messages:      cfg.Messages,
		tasks:         cfg.Tasks,
		maxDepth:      maxDepth,
		safetyTimeout: safety,
	}
}

func (iv *BusDelegateInvoker) InvokeDelegate(ctx context.Context, parent runtimectx.DelegationInfo, targetAgentID, task, toolCallID string) (string, error) {
	if parent.Depth >= iv.maxDepth {
		return "", fmt.Errorf("%w: depth %d reached max %d", ErrDelegationDepthExceeded, parent.Depth, iv.maxDepth)
	}
	if slices.Contains(parent.Chain, targetAgentID) {
		return "", fmt.Errorf("%w: %s already in chain %v", ErrDelegationCycle, targetAgentID, parent.Chain)
	}
	if _, err := iv.agents.GetByID(ctx, targetAgentID, parent.UserID); err != nil {
		return "", fmt.Errorf("%w: %s", ErrDelegateNotOwned, targetAgentID)
	}

	childRunID := uuid.NewString()
	if err := iv.consumeRunBudget(ctx, parent, toolCallID, childRunID); err != nil {
		return "", err
	}

	subThreadID, err := iv.threads.FindOrCreateSubThread(ctx, parent.UserID, parent.OriginatorRunID, targetAgentID)
	if err != nil {
		return "", fmt.Errorf("delegate: resolve sub-thread: %w", err)
	}

	if err := iv.runs.CreateChildRun(ctx, childRunID, subThreadID, targetAgentID, parent.UserID, parent.OriginatorRunID, parent.RunID); err != nil {
		return "", fmt.Errorf("delegate: create child run: %w", err)
	}

	// Pre-dispatch failures: the run exists but RunStream never ran and the
	// worker will never touch its status, so the invoker finalizes it.
	if err := iv.pools.Ensure(ctx, targetAgentID); err != nil {
		iv.failUndispatchedChild(childRunID, err)
		return "", err
	}

	chain := append(append([]string(nil), parent.Chain...), targetAgentID)
	payload := DispatchPayload{
		RunID:           childRunID,
		OriginatorRunID: parent.OriginatorRunID,
		ParentRunID:     parent.RunID,
		AgentID:         targetAgentID,
		UserID:          parent.UserID,
		ThreadID:        subThreadID,
		Input:           task,
		Chain:           chain,
		Depth:           parent.Depth + 1,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		iv.failUndispatchedChild(childRunID, err)
		return "", err
	}

	// Subscribe + publish on a context DETACHED from the caller's. Once the
	// child run doc exists, the dispatch must reach the bus so a worker
	// accepts it and owns the run's terminal status — if we published with the
	// caller ctx and it was already cancelled, the publish would be skipped
	// and the child run would be stranded in "running" forever.
	busCtx := context.WithoutCancel(ctx)
	corr := uuid.NewString()
	replyTopic := "reply." + corr
	sub, err := iv.bus.Subscribe(busCtx, replyTopic)
	if err != nil {
		iv.failUndispatchedChild(childRunID, err)
		return "", err
	}
	defer sub.Unsubscribe()

	msg := bus.Message{Body: body, ReplyTo: replyTopic, CorrID: corr}
	if err := iv.bus.Publish(busCtx, dispatchTopic(targetAgentID), msg); err != nil {
		// Never delivered → no worker will ever touch this run's status; the
		// invoker is the only party that can finalize it.
		iv.failUndispatchedChild(childRunID, err)
		return "", err
	}

	// From here a pool subscriber holds the dispatch, so the worker (or the
	// runtime's defer) owns the child run's terminal status. Wait for the
	// reply: the caller ctx gives a prompt return on cancellation (the worker
	// is still stopped via the originator cancel cascade and finalizes its own
	// status); safetyTimeout guards a wedged child that never replies.
	var safety <-chan time.Time
	if iv.safetyTimeout > 0 {
		timer := time.NewTimer(iv.safetyTimeout)
		defer timer.Stop()
		safety = timer.C
	}

	select {
	case reply := <-sub.Messages():
		var dr DispatchReply
		if err := json.Unmarshal(reply.Body, &dr); err != nil {
			return "", fmt.Errorf("delegate: decode reply: %w", err)
		}
		if dr.Error != "" {
			// The child worker produced this reply, so it (or the runtime)
			// already owns the child run's terminal status.
			return "", errors.New(dr.Error)
		}
		res := runResultFromWire(dr.Result)
		iv.persistSubThread(busCtx, subThreadID, targetAgentID, parent, task, res)
		if res == nil {
			return "", nil
		}
		return res.Output, nil

	case <-ctx.Done():
		return "", ctx.Err()

	case <-safety:
		// Catastrophic: a child never replied within the safety bound while the
		// caller is still live. Cancel the whole originator tree so the wedged
		// subtree unwinds. (Status of those runs is owned by their workers.)
		iv.pools.CancelTask(parent.OriginatorRunID)
		_ = iv.bus.Publish(context.Background(), cancelTopic(parent.OriginatorRunID), bus.Message{})
		return "", bus.ErrRequestTimeout

	case <-sub.Done():
		return "", errors.New("delegate: reply subscription closed")
	}
}

func (iv *BusDelegateInvoker) consumeRunBudget(ctx context.Context, parent runtimectx.DelegationInfo, toolCallID, childRunID string) error {
	if iv.tasks == nil {
		return nil
	}
	if _, err := iv.tasks.BudgetStatus(ctx, parent.OriginatorRunID); err != nil {
		return fmt.Errorf("delegate: budget status: %w", err)
	}
	status, ok, err := iv.tasks.TryConsumeRun(ctx, parent.OriginatorRunID, parent.UserID, syncBudgetKey(parent.RunID, toolCallID, childRunID))
	if err != nil {
		return fmt.Errorf("delegate: consume run budget: %w", err)
	}
	if !ok {
		return agent.RunBudgetErrorFromStatus(status)
	}
	return nil
}

func syncBudgetKey(parentRunID, toolCallID, childRunID string) string {
	if parentRunID != "" && toolCallID != "" {
		return "sync:" + parentRunID + ":" + toolCallID
	}
	return "sync:" + childRunID
}

func (iv *BusDelegateInvoker) persistSubThread(ctx context.Context, subThreadID, targetAgentID string, parent runtimectx.DelegationInfo, task string, res *agent.RunResult) {
	if iv.messages == nil {
		return
	}
	msgs := []llm.ChatMessage{{
		Role:    "user",
		Content: task,
		Metadata: map[string]any{
			"delegated_from_run_id": parent.RunID,
			"originator_run_id":     parent.OriginatorRunID,
			"parent_agent_id":       lastInChain(parent.Chain),
			"target_agent_id":       targetAgentID,
		},
	}}
	if res != nil {
		msgs = append(msgs, res.NewMessages...)
	}
	// Best-effort: a persistence failure does not invalidate the result the
	// caller already received.
	_, _ = iv.messages.InsertMany(ctx, subThreadID, targetAgentID, parent.UserID, msgs)
}

func (iv *BusDelegateInvoker) failUndispatchedChild(runID string, cause error) {
	if iv.runs == nil {
		return
	}
	_ = iv.runs.UpdateStatus(context.Background(), runID, "failed", cause.Error())
}

func lastInChain(chain []string) string {
	if len(chain) == 0 {
		return ""
	}
	return chain[len(chain)-1]
}
