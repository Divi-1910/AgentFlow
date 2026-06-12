package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/model"

	"github.com/google/uuid"
)

const (
	defaultJobLease          = 30 * time.Second
	defaultJobLockLease      = 30 * time.Second
	defaultCallbackLockLease = 30 * time.Second
	defaultCoordinatorTick   = time.Second
	defaultConcurrentJobs    = 5
)

type coordinatorJobStore interface {
	FindQueueCandidates(ctx context.Context, limit int) ([]model.JobDocument, error)
	CountActiveForOriginator(ctx context.Context, originatorRunID string) (int64, error)
	FindExpiredRunningJobs(ctx context.Context, before time.Time, limit int) ([]model.JobDocument, error)
	FindExpiredRunningCallbacks(ctx context.Context, before time.Time, limit int) ([]model.JobDocument, error)
	HasRunningTargetJob(ctx context.Context, originatorRunID, targetAgentID, excludeJobID string) (bool, error)
	HasRunningCallback(ctx context.Context, parentThreadID, excludeJobID string) (bool, error)
	AcquireLock(ctx context.Context, lockType, lockKey, activeJobID, activeRunID, owner string, ttl time.Duration) (bool, error)
	ReleaseLock(ctx context.Context, lockKey, activeJobID string) error
	ClaimJobStarting(ctx context.Context, jobID, owner string, lease time.Duration) (model.JobDocument, bool, error)
	MarkJobDispatched(ctx context.Context, jobID, childRunID, childThreadID string) error
	MarkJobFailed(ctx context.Context, jobID, errText string) error
	MarkJobCancelled(ctx context.Context, jobID, errText string) error
	FindReadyWaitingRunIDs(ctx context.Context, limit int) ([]string, error)
	FindQueuedCallbacks(ctx context.Context, limit int) ([]model.JobDocument, error)
	MarkCallbackRunning(ctx context.Context, jobID, callbackRunID, owner string, lease time.Duration) error
	MarkCallbackFailed(ctx context.Context, jobID, errText string) error
	MarkCallbackCancelled(ctx context.Context, jobID, errText string) error
}

type coordinatorRunStore interface {
	CreateChildRunWithKind(ctx context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error
	UpdateStatus(ctx context.Context, runID, status, lastError string) error
	TransitionStatus(ctx context.Context, runID string, from, to string) (bool, error)
	IncrementAttempt(ctx context.Context, runID string) (int, error)
	GetRun(ctx context.Context, runID string) (*agent.RunInfo, error)
}

type JobCoordinatorConfig struct {
	Bus      bus.MessageBus
	Pools    *PoolManager
	Threads  ThreadStore
	Runs     coordinatorRunStore
	Jobs     coordinatorJobStore
	Tasks    durableCancelStore
	Hub      *JobHub
	WorkerID string
	Logger   *slog.Logger

	ConcurrentJobs    int
	JobLease          time.Duration
	JobLockLease      time.Duration
	CallbackLockLease time.Duration
	ReclaimGrace      time.Duration
	Tick              time.Duration
}

type JobCoordinator struct {
	bus     bus.MessageBus
	pools   *PoolManager
	threads ThreadStore
	runs    coordinatorRunStore
	jobs    coordinatorJobStore
	tasks   durableCancelStore
	hub     *JobHub
	owner   string
	logger  *slog.Logger

	concurrentJobs    int
	jobLease          time.Duration
	jobLockLease      time.Duration
	callbackLockLease time.Duration
	reclaimGrace      time.Duration
	tick              time.Duration
}

func NewJobCoordinator(cfg JobCoordinatorConfig) *JobCoordinator {
	owner := cfg.WorkerID
	if owner == "" {
		owner = "coordinator-" + uuid.NewString()
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	concurrentJobs := cfg.ConcurrentJobs
	if concurrentJobs <= 0 {
		concurrentJobs = defaultConcurrentJobs
	}
	jobLease := cfg.JobLease
	if jobLease <= 0 {
		jobLease = defaultJobLease
	}
	jobLockLease := cfg.JobLockLease
	if jobLockLease <= 0 {
		jobLockLease = defaultJobLockLease
	}
	callbackLockLease := cfg.CallbackLockLease
	if callbackLockLease <= 0 {
		callbackLockLease = defaultCallbackLockLease
	}
	reclaimGrace := cfg.ReclaimGrace
	if reclaimGrace <= 0 {
		reclaimGrace = 2 * leaseRefreshInterval(jobLease)
	}
	tick := cfg.Tick
	if tick <= 0 {
		tick = defaultCoordinatorTick
	}
	return &JobCoordinator{
		bus:               cfg.Bus,
		pools:             cfg.Pools,
		threads:           cfg.Threads,
		runs:              cfg.Runs,
		jobs:              cfg.Jobs,
		tasks:             cfg.Tasks,
		hub:               cfg.Hub,
		owner:             owner,
		logger:            logger,
		concurrentJobs:    concurrentJobs,
		jobLease:          jobLease,
		jobLockLease:      jobLockLease,
		callbackLockLease: callbackLockLease,
		reclaimGrace:      reclaimGrace,
		tick:              tick,
	}
}

func (c *JobCoordinator) Start(ctx context.Context) {
	go c.Run(ctx)
}

func (c *JobCoordinator) Run(ctx context.Context) {
	if c == nil || c.bus == nil || c.pools == nil || c.threads == nil || c.runs == nil || c.jobs == nil {
		return
	}
	ticker := time.NewTicker(c.tick)
	defer ticker.Stop()
	c.tickOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.tickOnce(ctx)
		case <-c.hubWake():
			c.tickOnce(ctx)
		}
	}
}

func (c *JobCoordinator) hubWake() <-chan struct{} {
	if c.hub == nil {
		return nil
	}
	return c.hub.Wake()
}

func (c *JobCoordinator) tickOnce(ctx context.Context) {
	c.expireStaleRunningJobs(ctx)
	c.expireStaleRunningCallbacks(ctx)
	c.launchQueuedJobs(ctx)
	c.resumeReadyRuns(ctx)
	c.launchCallbacks(ctx)
}

func (c *JobCoordinator) expireStaleRunningJobs(ctx context.Context) {
	jobs, err := c.jobs.FindExpiredRunningJobs(ctx, time.Now().Add(-c.reclaimGrace), 25)
	if err != nil {
		c.logger.Warn("job coordinator: find expired running jobs", "error", err)
		return
	}
	for _, doc := range jobs {
		if ctx.Err() != nil {
			return
		}
		if c.runIsWaiting(ctx, doc.ChildRunID) {
			continue
		}
		c.failJob(doc, fmt.Errorf("job lease expired"))
	}
}

func (c *JobCoordinator) expireStaleRunningCallbacks(ctx context.Context) {
	jobs, err := c.jobs.FindExpiredRunningCallbacks(ctx, time.Now().Add(-c.reclaimGrace), 25)
	if err != nil {
		c.logger.Warn("job coordinator: find expired running callbacks", "error", err)
		return
	}
	for _, doc := range jobs {
		if ctx.Err() != nil {
			return
		}
		if c.runIsWaiting(ctx, doc.CallbackRunID) {
			continue
		}
		_ = c.jobs.MarkCallbackFailed(context.Background(), doc.JobID, "callback lease expired")
	}
}

func (c *JobCoordinator) runIsWaiting(ctx context.Context, runID string) bool {
	if runID == "" {
		return false
	}
	info, err := c.runs.GetRun(ctx, runID)
	return err == nil && info != nil && info.Status == string(model.RunStatusWaitingJobs)
}

func (c *JobCoordinator) launchQueuedJobs(ctx context.Context) {
	candidates, err := c.jobs.FindQueueCandidates(ctx, 25)
	if err != nil {
		c.logger.Warn("job coordinator: find queued jobs", "error", err)
		return
	}
	for _, doc := range candidates {
		if ctx.Err() != nil {
			return
		}
		if c.isCancelled(ctx, doc.OriginatorRunID) {
			_ = c.jobs.MarkJobCancelled(context.Background(), doc.JobID, "originator cancelled")
			continue
		}
		active, err := c.jobs.CountActiveForOriginator(ctx, doc.OriginatorRunID)
		if err != nil {
			c.logger.Warn("job coordinator: count active", "job_id", doc.JobID, "error", err)
			continue
		}
		if active >= int64(c.concurrentJobs) {
			continue
		}
		runningSameTarget, err := c.jobs.HasRunningTargetJob(ctx, doc.OriginatorRunID, doc.TargetAgentID, doc.JobID)
		if err != nil {
			c.logger.Warn("job coordinator: check target running job", "job_id", doc.JobID, "error", err)
			continue
		}
		if runningSameTarget {
			continue
		}
		lockKey := targetLockKey(doc.OriginatorRunID, doc.TargetAgentID)
		acquired, err := c.jobs.AcquireLock(ctx, "target", lockKey, doc.JobID, doc.ChildRunID, c.owner, c.jobLockLease)
		if err != nil {
			c.logger.Warn("job coordinator: acquire target lock", "job_id", doc.JobID, "error", err)
			continue
		}
		if !acquired {
			continue
		}
		claimed, ok, err := c.jobs.ClaimJobStarting(ctx, doc.JobID, c.owner, c.jobLease)
		if err != nil {
			c.logger.Warn("job coordinator: claim job", "job_id", doc.JobID, "error", err)
			_ = c.jobs.ReleaseLock(context.Background(), lockKey, doc.JobID)
			continue
		}
		if !ok {
			_ = c.jobs.ReleaseLock(context.Background(), lockKey, doc.JobID)
			continue
		}
		c.dispatchJob(ctx, claimed)
	}
}

func (c *JobCoordinator) dispatchJob(ctx context.Context, doc model.JobDocument) {
	subThreadID, err := c.threads.FindOrCreateSubThread(ctx, doc.UserID, doc.OriginatorRunID, doc.TargetAgentID)
	if err != nil {
		c.failJob(doc, fmt.Errorf("resolve sub-thread: %w", err))
		return
	}
	childRunID := doc.ChildRunID
	if childRunID == "" {
		childRunID = uuid.NewString()
	}
	if err := c.runs.CreateChildRunWithKind(ctx, childRunID, subThreadID, doc.TargetAgentID, doc.UserID, doc.OriginatorRunID, doc.ParentRunID, agent.InvocationAsyncJob, doc.JobID); err != nil {
		c.failJob(doc, fmt.Errorf("create child run: %w", err))
		return
	}
	if err := c.pools.Ensure(ctx, doc.TargetAgentID); err != nil {
		_ = c.runs.UpdateStatus(context.Background(), childRunID, string(model.RunStatusFailed), err.Error())
		c.failJob(doc, err)
		return
	}
	chain := append([]string(nil), doc.DelegationChain...)
	if len(chain) == 0 {
		chain = []string{doc.ParentAgentID}
	}
	chain = append(chain, doc.TargetAgentID)
	payload := DispatchPayload{
		RunID:                 childRunID,
		OriginatorRunID:       doc.OriginatorRunID,
		ParentRunID:           doc.ParentRunID,
		AgentID:               doc.TargetAgentID,
		UserID:                doc.UserID,
		ThreadID:              subThreadID,
		Input:                 doc.Task,
		Chain:                 chain,
		Depth:                 doc.DelegationDepth + 1,
		InvocationKind:        agent.InvocationAsyncJob,
		JobID:                 doc.JobID,
		PersistResultMessages: true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		_ = c.runs.UpdateStatus(context.Background(), childRunID, string(model.RunStatusFailed), err.Error())
		c.failJob(doc, err)
		return
	}
	if err := c.jobs.MarkJobDispatched(ctx, doc.JobID, childRunID, subThreadID); err != nil {
		_ = c.runs.UpdateStatus(context.Background(), childRunID, string(model.RunStatusFailed), err.Error())
		c.failJob(doc, err)
		return
	}
	c.publishParentJobEvent(doc.ParentRunID, agent.EventJobStarted, doc, nil)
	if err := c.bus.Publish(ctx, dispatchTopic(doc.TargetAgentID), bus.Message{Body: body}); err != nil {
		_ = c.runs.UpdateStatus(context.Background(), childRunID, string(model.RunStatusFailed), err.Error())
		c.failJob(doc, err)
		return
	}
}

func (c *JobCoordinator) resumeReadyRuns(ctx context.Context) {
	runIDs, err := c.jobs.FindReadyWaitingRunIDs(ctx, 50)
	if err != nil {
		c.logger.Warn("job coordinator: find ready waiting runs", "error", err)
		return
	}
	for _, runID := range runIDs {
		if ctx.Err() != nil {
			return
		}
		info, err := c.runs.GetRun(ctx, runID)
		if err != nil || info == nil || info.Status != string(model.RunStatusWaitingJobs) {
			continue
		}
		if c.isCancelled(ctx, info.OriginatorRunID) {
			_ = c.runs.UpdateStatus(context.Background(), runID, string(model.RunStatusCancelled), "originator cancelled")
			continue
		}
		claimed, err := c.runs.TransitionStatus(ctx, runID, string(model.RunStatusWaitingJobs), string(model.RunStatusRunning))
		if err != nil || !claimed {
			continue
		}
		if err := c.pools.Ensure(ctx, info.AgentID); err != nil {
			_ = c.runs.UpdateStatus(context.Background(), runID, string(model.RunStatusFailed), err.Error())
			continue
		}
		attempt, err := c.runs.IncrementAttempt(ctx, runID)
		if err != nil {
			c.logger.Warn("job coordinator: increment attempt", "run_id", runID, "error", err)
			attempt = info.Attempt + 1
		}
		payload := DispatchPayload{
			RunID:                 runID,
			OriginatorRunID:       info.OriginatorRunID,
			ParentRunID:           info.ParentRunID,
			AgentID:               info.AgentID,
			UserID:                info.UserID,
			ThreadID:              info.ThreadID,
			IsResume:              true,
			Attempt:               attempt,
			InvocationKind:        info.InvocationKind,
			JobID:                 info.JobID,
			PersistResultMessages: true,
		}
		body, err := json.Marshal(payload)
		if err != nil {
			_ = c.runs.UpdateStatus(context.Background(), runID, string(model.RunStatusFailed), err.Error())
			continue
		}
		if err := c.bus.Publish(ctx, dispatchTopic(info.AgentID), bus.Message{Body: body}); err != nil {
			_ = c.runs.UpdateStatus(context.Background(), runID, string(model.RunStatusFailed), err.Error())
			continue
		}
	}
}

func (c *JobCoordinator) launchCallbacks(ctx context.Context) {
	jobs, err := c.jobs.FindQueuedCallbacks(ctx, 20)
	if err != nil {
		c.logger.Warn("job coordinator: find callbacks", "error", err)
		return
	}
	for _, doc := range jobs {
		if ctx.Err() != nil {
			return
		}
		if c.isCancelled(ctx, doc.OriginatorRunID) {
			_ = c.jobs.MarkCallbackCancelled(context.Background(), doc.JobID, "originator cancelled")
			continue
		}
		runningSameThread, err := c.jobs.HasRunningCallback(ctx, doc.ParentThreadID, doc.JobID)
		if err != nil {
			c.logger.Warn("job coordinator: check running callback", "job_id", doc.JobID, "error", err)
			continue
		}
		if runningSameThread {
			continue
		}
		callbackRunID := uuid.NewString()
		lockKey := callbackLockKey(doc.ParentThreadID)
		acquired, err := c.jobs.AcquireLock(ctx, "callback_thread", lockKey, doc.JobID, callbackRunID, c.owner, c.callbackLockLease)
		if err != nil {
			c.logger.Warn("job coordinator: acquire callback lock", "job_id", doc.JobID, "error", err)
			continue
		}
		if !acquired {
			continue
		}
		if err := c.jobs.MarkCallbackRunning(ctx, doc.JobID, callbackRunID, c.owner, c.callbackLockLease); err != nil {
			_ = c.jobs.ReleaseLock(context.Background(), lockKey, doc.JobID)
			continue
		}
		if err := c.runs.CreateChildRunWithKind(ctx, callbackRunID, doc.ParentThreadID, doc.ParentAgentID, doc.UserID, doc.OriginatorRunID, doc.ParentRunID, agent.InvocationCallback, doc.JobID); err != nil {
			_ = c.jobs.MarkCallbackFailed(context.Background(), doc.JobID, err.Error())
			continue
		}
		if err := c.pools.Ensure(ctx, doc.ParentAgentID); err != nil {
			_ = c.runs.UpdateStatus(context.Background(), callbackRunID, string(model.RunStatusFailed), err.Error())
			_ = c.jobs.MarkCallbackFailed(context.Background(), doc.JobID, err.Error())
			continue
		}
		payload := DispatchPayload{
			RunID:                 callbackRunID,
			OriginatorRunID:       doc.OriginatorRunID,
			ParentRunID:           doc.ParentRunID,
			AgentID:               doc.ParentAgentID,
			UserID:                doc.UserID,
			ThreadID:              doc.ParentThreadID,
			SystemContext:         callbackSystemContext(doc),
			InvocationKind:        agent.InvocationCallback,
			JobID:                 doc.JobID,
			PersistResultMessages: true,
		}
		body, err := json.Marshal(payload)
		if err != nil {
			_ = c.runs.UpdateStatus(context.Background(), callbackRunID, string(model.RunStatusFailed), err.Error())
			_ = c.jobs.MarkCallbackFailed(context.Background(), doc.JobID, err.Error())
			continue
		}
		if err := c.bus.Publish(ctx, dispatchTopic(doc.ParentAgentID), bus.Message{Body: body}); err != nil {
			_ = c.runs.UpdateStatus(context.Background(), callbackRunID, string(model.RunStatusFailed), err.Error())
			_ = c.jobs.MarkCallbackFailed(context.Background(), doc.JobID, err.Error())
			continue
		}
	}
}

func (c *JobCoordinator) failJob(doc model.JobDocument, err error) {
	errText := err.Error()
	_ = c.jobs.MarkJobFailed(context.Background(), doc.JobID, errText)
	if c.hub != nil {
		c.hub.Notify(doc.JobID)
	}
	c.publishParentJobEvent(doc.ParentRunID, agent.EventJobFailed, doc, &agent.ErrMeta{Code: "job.failed", Message: errText})
}

func (c *JobCoordinator) publishParentJobEvent(parentRunID string, typ agent.EventType, doc model.JobDocument, errMeta *agent.ErrMeta) {
	if c.bus == nil || parentRunID == "" {
		return
	}
	body, _ := json.Marshal(agent.StreamEvent{
		Type: typ,
		Job: &agent.JobMeta{
			ID:            doc.JobID,
			Status:        doc.Status,
			Mode:          doc.Mode,
			DelegateTool:  doc.DelegateTool,
			TargetAgentID: doc.TargetAgentID,
		},
		Error: errMeta,
	})
	_ = c.bus.Publish(context.Background(), eventsTopic(parentRunID), bus.Message{Body: body})
}

func (c *JobCoordinator) isCancelled(ctx context.Context, originatorRunID string) bool {
	if c.tasks == nil {
		return false
	}
	cancelled, err := c.tasks.IsCancelled(ctx, originatorRunID)
	return err == nil && cancelled
}

func targetLockKey(originatorRunID, targetAgentID string) string {
	return "target:" + originatorRunID + ":" + targetAgentID
}

func callbackLockKey(threadID string) string {
	return "callback_thread:" + threadID
}

func callbackSystemContext(doc model.JobDocument) string {
	instruction := doc.CallbackInstruction
	if instruction == "" {
		instruction = agent.DefaultCallbackInstruction
	}
	if doc.Status == string(model.JobStatusSucceeded) {
		return fmt.Sprintf("A background task you started earlier has finished.\n\njob_id: %s\ndelegate_tool: %s\nstatus: succeeded\ninstruction: %s\n\nresult:\n%s\n\nShare this result with the user, continuing the earlier conversation.",
			doc.JobID, doc.DelegateTool, instruction, doc.Output)
	}
	errText := doc.Error
	if errText == "" {
		errText = "the task did not succeed"
	}
	return fmt.Sprintf("A background task you started earlier could not be completed.\n\njob_id: %s\ndelegate_tool: %s\nstatus: failed\ninstruction: %s\n\nerror:\n%s\n\nTell the user it failed and explain what went wrong, continuing the earlier conversation.",
		doc.JobID, doc.DelegateTool, instruction, errText)
}
