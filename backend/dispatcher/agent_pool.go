package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"backend/agent"
	"backend/bus"
)

// runStatusUpdater is the minimal run-status surface the worker uses to mark a
// terminal status on pre-RunStream bail paths (decode/prepare error, pre-cancel,
// panic). Once RunStream is entered, the runtime's own defer owns status.
type runStatusUpdater interface {
	UpdateStatus(ctx context.Context, runID, status, lastError string) error
}

type AgentPool struct {
	agentID  string
	bus      bus.MessageBus
	preparer *RunPreparer
	runtime  Runtime
	status   runStatusUpdater
	sub      bus.Subscription
	workers  int
	rootCtx  context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	cancels  *CancelRegistry
}

func NewAgentPool(
	rootCtx context.Context,
	agentID string,
	b bus.MessageBus,
	preparer *RunPreparer,
	runtime Runtime,
	status runStatusUpdater,
	workers int,
	cancels *CancelRegistry,
) *AgentPool {
	if rootCtx == nil {
		rootCtx = context.Background()
	}
	ctx, cancel := context.WithCancel(rootCtx)
	if workers <= 0 {
		workers = defaultWorkerCount
	}
	if cancels == nil {
		cancels = NewCancelRegistry(0)
	}
	return &AgentPool{
		agentID:  agentID,
		bus:      b,
		preparer: preparer,
		runtime:  runtime,
		status:   status,
		workers:  workers,
		rootCtx:  ctx,
		cancel:   cancel,
		cancels:  cancels,
	}
}

func (p *AgentPool) Start() error {
	sub, err := p.bus.Subscribe(p.rootCtx, dispatchTopic(p.agentID))
	if err != nil {
		return err
	}
	p.sub = sub
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go p.workerLoop()
	}
	return nil
}

func (p *AgentPool) Stop() {
	p.cancel()
	if p.sub != nil {
		_ = p.sub.Unsubscribe()
	}
	p.wg.Wait()
}

func (p *AgentPool) workerLoop() {
	defer p.wg.Done()
	for {
		select {
		case msg := <-p.sub.Messages():
			p.handleDispatch(msg)
		case <-p.sub.Done():
			return
		case <-p.rootCtx.Done():
			return
		}
	}
}

func (p *AgentPool) handleDispatch(msg bus.Message) {
	var payload DispatchPayload
	if err := json.Unmarshal(msg.Body, &payload); err != nil {
		// No reliable run id on a decode failure — just report to the caller.
		p.publishReply(msg, DispatchReply{Error: fmt.Sprintf("dispatcher: decode dispatch payload: %v", err)})
		return
	}
	if payload.OriginatorRunID == "" {
		payload.OriginatorRunID = payload.RunID
	}

	defer func() {
		if rec := recover(); rec != nil {
			requestFromPayload(payload).Logger.Error("panic in dispatcher worker", "error", rec, "stack", string(debug.Stack()))
			p.markTerminal(payload.RunID, "failed", fmt.Sprintf("panic: %v", rec))
			p.publishReply(msg, DispatchReply{Error: fmt.Sprintf("panic in dispatcher worker: %v", rec)})
		}
	}()

	// Pre-cancel: if the originator was already cancelled before this dispatch
	// was picked up, don't run at all — the worker owns the terminal status
	// because RunStream never starts. "failed", not "interrupted": interrupted
	// promises a resumable checkpoint (runtime.go semantics), and a run that
	// never started has none.
	if p.cancels.IsCanceled(payload.OriginatorRunID) {
		p.markTerminal(payload.RunID, "failed", "cancelled before start (no checkpoint)")
		p.publishReply(msg, DispatchReply{Error: context.Canceled.Error()})
		return
	}

	req := requestFromPayload(payload)
	runCtx, cancel := context.WithCancel(p.rootCtx)
	defer cancel()

	cancelSub, cancelDone := p.watchCancellation(runCtx, payload.OriginatorRunID, cancel)
	if cancelDone != nil {
		defer waitForCancelWatcher(cancelDone)
	}
	if cancelSub != nil {
		defer cancelSub.Unsubscribe()
	}

	prepared, err := p.preparer.Prepare(runCtx, req)
	if err != nil {
		p.markTerminal(payload.RunID, "failed", err.Error())
		p.publishReply(msg, DispatchReply{Error: err.Error()})
		return
	}

	// From here RunStream is entered, so the runtime's own defer owns the
	// run's terminal status — the worker must not write it.
	workerEvents := make(chan agent.StreamEvent, 128)
	eventsDone := make(chan struct{})
	go p.forwardWorkerEvents(runCtx, payload.RunID, workerEvents, eventsDone)

	res, err := p.runtime.RunStream(runCtx, prepared.Agent, prepared.RunCtx, workerEvents)
	<-eventsDone
	if err != nil {
		p.publishReply(msg, DispatchReply{Result: wireFromRunResult(res), Error: err.Error()})
		return
	}
	p.publishReply(msg, DispatchReply{Result: wireFromRunResult(res)})
}

// markTerminal sets a run's status on pre-RunStream bail paths. Best-effort:
// a status-write failure is logged but never blocks the bus reply.
func (p *AgentPool) markTerminal(runID, status, lastError string) {
	if p.status == nil || runID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = p.status.UpdateStatus(ctx, runID, status, lastError)
}

func (p *AgentPool) watchCancellation(ctx context.Context, originatorRunID string, cancel context.CancelFunc) (bus.Subscription, <-chan struct{}) {
	sub, err := p.bus.Subscribe(ctx, cancelTopic(originatorRunID), bus.WithBufferSize(1))
	if err != nil {
		return nil, nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-sub.Messages():
			p.cancels.Cancel(originatorRunID)
			cancel()
		case <-sub.Done():
		case <-ctx.Done():
		case <-p.rootCtx.Done():
		}
	}()
	// Re-check after subscribing: closes the dispatch→subscribe race for a
	// cancel that landed between dispatch publish and this subscription.
	if p.cancels.IsCanceled(originatorRunID) {
		cancel()
	}
	return sub, done
}

func (p *AgentPool) forwardWorkerEvents(ctx context.Context, runID string, workerEvents <-chan agent.StreamEvent, done chan<- struct{}) {
	defer close(done)
	for event := range workerEvents {
		body, err := json.Marshal(event)
		if err != nil {
			continue
		}
		// Drop the event on publish failure but keep draining workerEvents.
		// Exiting the loop here would leave runtime.RunStream blocked on the
		// 129th send once the 128-element buffer fills, with no path out.
		// Pinned by TestAgentPool_ForwardWorkerEventsKeepsDrainingOnPublishError.
		if err := p.bus.Publish(ctx, eventsTopic(runID), bus.Message{Body: body}); err != nil {
			continue
		}
	}
}

func (p *AgentPool) publishReply(request bus.Message, reply DispatchReply) {
	if request.ReplyTo == "" {
		return
	}
	body, err := json.Marshal(reply)
	if err != nil {
		body, _ = json.Marshal(DispatchReply{Error: fmt.Sprintf("dispatcher: encode reply: %v", err)})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = p.bus.Publish(ctx, request.ReplyTo, bus.Message{
		Body:   body,
		CorrID: request.CorrID,
	})
}

func waitForCancelWatcher(done <-chan struct{}) {
	select {
	case <-done:
	case <-time.After(time.Second):
	}
}

func dispatchTopic(agentID string) string {
	return "agent." + agentID + ".dispatch"
}

func eventsTopic(taskID string) string {
	return "task." + taskID + ".events"
}

func cancelTopic(taskID string) string {
	return "task." + taskID + ".cancel"
}
