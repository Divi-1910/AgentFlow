package dispatcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/llm"
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
	messages MessageStore
	jobs     WorkerJobStore
	tasks    DurableCancelStore
	hub      *JobHub
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
	messages MessageStore,
	jobs WorkerJobStore,
	tasks DurableCancelStore,
	hub *JobHub,
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
		messages: messages,
		jobs:     jobs,
		tasks:    tasks,
		hub:      hub,
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
	if p.isCanceled(payload.OriginatorRunID) {
		p.markTerminal(payload.RunID, "failed", "cancelled before start (no checkpoint)")
		p.markAsyncCanceled(payload)
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
		p.markAsyncFailed(payload, err.Error())
		p.publishReply(msg, DispatchReply{Error: err.Error()})
		return
	}

	// From here RunStream is entered, so the runtime's own defer owns the
	// run's terminal status — the worker must not write it.
	workerEvents := make(chan agent.StreamEvent, 128)
	eventsDone := make(chan struct{})
	go p.forwardWorkerEvents(runCtx, payload.RunID, workerEvents, eventsDone)

	stopLeaseHeartbeat := p.startLeaseHeartbeat(payload)
	defer stopLeaseHeartbeat()

	res, err := p.runtime.RunStream(runCtx, prepared.Agent, prepared.RunCtx, workerEvents)
	<-eventsDone
	p.afterRun(payload, prepared, res, err)
	if err != nil {
		p.publishReply(msg, DispatchReply{Result: wireFromRunResult(res), Error: err.Error()})
		return
	}
	p.publishReply(msg, DispatchReply{Result: wireFromRunResult(res)})
}

func (p *AgentPool) afterRun(payload DispatchPayload, prepared PreparedRun, res *agent.RunResult, runErr error) {
	kind := payload.InvocationKind
	if kind == "" {
		kind = prepared.RunCtx.InvocationKind
	}
	jobID := payload.JobID
	if jobID == "" {
		jobID = prepared.RunCtx.JobID
	}

	if kind == agent.InvocationAsyncJob {
		p.persistRunMessages(payload, prepared, res, true)
		if jobID == "" || p.jobs == nil {
			return
		}
		if runErr != nil {
			var applied bool
			var writeErr error
			if errors.Is(runErr, context.Canceled) {
				applied, writeErr = p.jobs.MarkJobCancelled(context.Background(), jobID, payload.RunID, runErr.Error())
			} else {
				applied, writeErr = p.jobs.MarkJobFailed(context.Background(), jobID, payload.RunID, runErr.Error())
			}
			// Only notify the parent if the fenced write actually applied —
			// otherwise this worker is a zombie from a superseded dispatch
			// attempt, and reporting job.completed/job.failed here would
			// tell the parent about an outcome the durable store rejected.
			if writeErr == nil && applied {
				p.notifyJobTerminal(payload, jobID, false, runErr.Error())
			}
			return
		}
		if res != nil && res.Status == agent.RunResultWaiting {
			return
		}
		output := ""
		if res != nil {
			output = res.Output
		}
		applied, writeErr := p.jobs.MarkJobSucceeded(context.Background(), jobID, payload.RunID, output)
		if writeErr == nil && applied {
			p.notifyJobTerminal(payload, jobID, true, "")
		}
		return
	}

	if kind == agent.InvocationCallback {
		p.persistRunMessages(payload, prepared, res, false)
		if jobID == "" || p.jobs == nil {
			return
		}
		if runErr != nil {
			if errors.Is(runErr, context.Canceled) {
				_ = p.jobs.MarkCallbackCancelled(context.Background(), jobID, payload.RunID, runErr.Error())
			} else {
				_ = p.jobs.MarkCallbackFailed(context.Background(), jobID, payload.RunID, runErr.Error())
			}
			return
		}
		if res != nil && res.Status == agent.RunResultWaiting {
			return
		}
		_ = p.jobs.MarkCallbackCompleted(context.Background(), jobID, payload.RunID)
		return
	}

	if payload.PersistResultMessages {
		p.persistRunMessages(payload, prepared, res, false)
	}
}

func (p *AgentPool) startLeaseHeartbeat(payload DispatchPayload) func() {
	if p.jobs == nil || payload.JobID == "" {
		return func() {}
	}
	kind := payload.InvocationKind
	ttl := defaultJobLockLease
	if kind == agent.InvocationCallback {
		ttl = defaultCallbackLockLease
	}
	refresh := func(ctx context.Context, owner string) error {
		switch kind {
		case agent.InvocationAsyncJob:
			return p.jobs.RefreshJobLease(ctx, payload.JobID, payload.RunID, payload.OriginatorRunID, payload.AgentID, owner, ttl)
		case agent.InvocationCallback:
			return p.jobs.RefreshCallbackLease(ctx, payload.JobID, payload.RunID, payload.ThreadID, owner, ttl)
		default:
			return nil
		}
	}
	if kind != agent.InvocationAsyncJob && kind != agent.InvocationCallback {
		return func() {}
	}

	owner := "worker:" + payload.RunID
	ctx, cancel := context.WithCancel(p.rootCtx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		interval := leaseRefreshInterval(ttl)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			p.refreshLease(ctx, refresh, owner)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
}

func (p *AgentPool) refreshLease(ctx context.Context, refresh func(context.Context, string) error, owner string) {
	if ctx.Err() != nil {
		return
	}
	refreshCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := refresh(refreshCtx, owner); err != nil {
		requestLogger := slog.Default()
		requestLogger.Warn("async lease refresh failed", "error", err)
	}
}

func leaseRefreshInterval(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		ttl = defaultJobLockLease
	}
	interval := ttl / 3
	if interval < time.Second {
		interval = ttl / 2
	}
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	return interval
}

func (p *AgentPool) persistRunMessages(payload DispatchPayload, prepared PreparedRun, res *agent.RunResult, includeInput bool) {
	if p.messages == nil || res == nil {
		return
	}
	msgs := make([]llm.ChatMessage, 0, len(res.NewMessages)+1)
	if includeInput && !payload.IsResume && payload.Input != "" {
		msgs = append(msgs, llm.ChatMessage{Role: "user", Content: payload.Input})
	}
	msgs = append(msgs, res.NewMessages...)
	if len(msgs) == 0 {
		return
	}
	_, _ = p.messages.InsertMany(context.Background(), prepared.RunCtx.ThreadID, prepared.Agent.ID, prepared.RunCtx.Memory.UserID, msgs)
}

func (p *AgentPool) notifyJobTerminal(payload DispatchPayload, jobID string, succeeded bool, errText string) {
	if p.hub != nil {
		p.hub.Notify(jobID)
	}
	if p.bus == nil || payload.ParentRunID == "" {
		return
	}
	eventType := agent.EventJobCompleted
	var errMeta *agent.ErrMeta
	if !succeeded {
		eventType = agent.EventJobFailed
		errMeta = &agent.ErrMeta{Code: "job.failed", Message: errText}
	}
	_ = p.bus.Publish(context.Background(), eventsTopic(payload.ParentRunID), bus.Message{
		Body: mustJSON(agent.StreamEvent{
			Type:  eventType,
			Job:   &agent.JobMeta{ID: jobID},
			Error: errMeta,
		}),
	})
}

func (p *AgentPool) markAsyncFailed(payload DispatchPayload, errText string) {
	if p.jobs == nil || payload.JobID == "" {
		return
	}
	switch payload.InvocationKind {
	case agent.InvocationAsyncJob:
		applied, err := p.jobs.MarkJobFailed(context.Background(), payload.JobID, payload.RunID, errText)
		if err == nil && applied {
			p.notifyJobTerminal(payload, payload.JobID, false, errText)
		}
	case agent.InvocationCallback:
		_ = p.jobs.MarkCallbackFailed(context.Background(), payload.JobID, payload.RunID, errText)
	}
}

func (p *AgentPool) markAsyncCanceled(payload DispatchPayload) {
	if p.jobs == nil || payload.JobID == "" {
		return
	}
	switch payload.InvocationKind {
	case agent.InvocationAsyncJob:
		applied, err := p.jobs.MarkJobCancelled(context.Background(), payload.JobID, payload.RunID, "cancelled before start")
		if err == nil && applied {
			p.notifyJobTerminal(payload, payload.JobID, false, "cancelled before start")
		}
	case agent.InvocationCallback:
		_ = p.jobs.MarkCallbackCancelled(context.Background(), payload.JobID, payload.RunID, "cancelled before start")
	}
}

func (p *AgentPool) isCanceled(originatorRunID string) bool {
	if p.cancels != nil && p.cancels.IsCanceled(originatorRunID) {
		return true
	}
	if p.tasks != nil {
		cancelled, err := p.tasks.IsCancelled(context.Background(), originatorRunID)
		return err == nil && cancelled
	}
	return false
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
	if p.isCanceled(originatorRunID) {
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

func mustJSON(v any) []byte {
	body, _ := json.Marshal(v)
	return body
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
