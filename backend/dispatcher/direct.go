package dispatcher

import (
	"context"
	"fmt"

	"backend/agent"
	"backend/bus"
)

// DirectDispatcher runs the top-level agent in-process (no bus dispatch for the
// top-level run). Bus and Pools are still required because a direct top-level
// run may call delegate tools, which dispatch children through the bus — and
// when the top-level context is cancelled, DirectDispatcher must publish the
// originator cancel so those children unwind (otherwise they orphan).
type DirectDispatcher struct {
	Preparer *RunPreparer
	Runtime  Runtime
	Bus      bus.MessageBus  // for the cancel cascade; may be nil if the agent has no delegates
	Pools    *PoolManager    // for CancelRegistry marking
}

func (d *DirectDispatcher) Dispatch(ctx context.Context, req DispatchRequest, events chan<- agent.StreamEvent) (*agent.RunResult, error) {
	if d.Preparer == nil || d.Runtime == nil {
		close(events)
		return nil, fmt.Errorf("dispatcher: direct dispatcher is not configured")
	}

	originator := req.OriginatorRunID
	if originator == "" {
		originator = req.RunID
	}

	// Cascade cancellation to any delegated children when the top-level
	// context is cancelled. context.AfterFunc reliably runs the cascade if ctx
	// is ever cancelled — unlike a select{ctx.Done / done}, which could race
	// with Dispatch returning and skip the publish, orphaning a child. stop()
	// suppresses the cascade on clean completion. No-op when the agent has no
	// delegates (publish to an unsubscribed topic).
	stop := context.AfterFunc(ctx, func() {
		if d.Pools != nil {
			d.Pools.CancelTask(originator)
		}
		if d.Bus != nil {
			_ = d.Bus.Publish(context.Background(), cancelTopic(originator), bus.Message{})
		}
	})
	defer stop()

	prepared, err := d.Preparer.Prepare(ctx, req)
	if err != nil {
		close(events)
		return nil, err
	}
	return d.Runtime.RunStream(ctx, prepared.Agent, prepared.RunCtx, events)
}

func (d *DirectDispatcher) EstimateSystemPromptTokens(ctx context.Context, req EstimateRequest) int {
	if d.Preparer == nil {
		return 0
	}
	return d.Preparer.EstimateSystemPromptTokens(ctx, req)
}
