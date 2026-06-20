package dispatcher

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"backend/agent"
	"backend/bus"
	"backend/model"
)

func TestJobCoordinatorLaunchQueuedJobsSerializesSameTargetAndDispatchesOtherTarget(t *testing.T) {
	jobs := &coordinatorFakeJobs{
		queue: []model.JobDocument{
			coordinatorQueuedJob("job-b", "agent-b"),
			coordinatorQueuedJob("job-c", "agent-c"),
		},
		runningTargets: map[string]bool{"origin-run\x00agent-b": true},
	}
	runs := &coordinatorFakeRuns{runs: map[string]*agent.RunInfo{}}
	recBus := &coordinatorRecordingBus{}
	c := newCoordinatorTestHarness(jobs, runs, recBus, nil)

	c.launchQueuedJobs(context.Background())

	if got, want := jobs.dispatched, []string{"job-c"}; !sameStrings(got, want) {
		t.Fatalf("dispatched jobs = %v, want %v", got, want)
	}
	dispatch := findRecordedPublish(t, recBus.publishes, dispatchTopic("agent-c"))
	payload := decodeDispatchPayload(t, dispatch.msg)
	if payload.InvocationKind != agent.InvocationAsyncJob || payload.JobID != "job-c" {
		t.Fatalf("payload = %+v, want async job-c", payload)
	}
}

func TestJobCoordinatorLaunchQueuedJobsHonorsActiveCap(t *testing.T) {
	jobs := &coordinatorFakeJobs{
		queue:  []model.JobDocument{coordinatorQueuedJob("job-b", "agent-b")},
		active: 1,
	}
	c := newCoordinatorTestHarness(jobs, &coordinatorFakeRuns{runs: map[string]*agent.RunInfo{}}, &coordinatorRecordingBus{}, nil)
	c.concurrentJobs = 1

	c.launchQueuedJobs(context.Background())

	if len(jobs.claimed) != 0 || len(jobs.dispatched) != 0 {
		t.Fatalf("claimed=%v dispatched=%v, want none while cap is full", jobs.claimed, jobs.dispatched)
	}
}

func TestJobCoordinatorLaunchQueuedJobsCancelsDurablyCancelledOriginator(t *testing.T) {
	jobs := &coordinatorFakeJobs{queue: []model.JobDocument{coordinatorQueuedJob("job-b", "agent-b")}}
	tasks := &coordinatorFakeTasks{cancelled: map[string]bool{"origin-run": true}}
	c := newCoordinatorTestHarness(jobs, &coordinatorFakeRuns{runs: map[string]*agent.RunInfo{}}, &coordinatorRecordingBus{}, tasks)

	c.launchQueuedJobs(context.Background())

	if got, want := jobs.cancelled, []string{"job-b"}; !sameStrings(got, want) {
		t.Fatalf("cancelled jobs = %v, want %v", got, want)
	}
	if len(jobs.claimed) != 0 {
		t.Fatalf("claimed jobs = %v, want none", jobs.claimed)
	}
}

func TestJobCoordinatorExpireStaleRunningJobsSkipsWaitingRun(t *testing.T) {
	jobs := &coordinatorFakeJobs{expiredJobs: []model.JobDocument{
		coordinatorRunningJob("job-waiting", "agent-b", "child-waiting"),
		coordinatorRunningJob("job-stale", "agent-b", "child-stale"),
	}}
	runs := &coordinatorFakeRuns{runs: map[string]*agent.RunInfo{
		"child-waiting": {RunID: "child-waiting", Status: string(model.RunStatusWaitingJobs)},
		"child-stale":   {RunID: "child-stale", Status: string(model.RunStatusRunning)},
	}}
	c := newCoordinatorTestHarness(jobs, runs, &coordinatorRecordingBus{}, nil)

	c.expireStaleRunningJobs(context.Background())

	if jobs.expiredBefore.IsZero() {
		t.Fatal("FindExpiredRunningJobs did not receive a reclaim cutoff")
	}
	if got, want := jobs.failed, []string{"job-stale"}; !sameStrings(got, want) {
		t.Fatalf("failed jobs = %v, want %v", got, want)
	}
}

func TestJobCoordinatorLaunchCallbacksSerializesParentThread(t *testing.T) {
	jobs := &coordinatorFakeJobs{callbacks: []model.JobDocument{
		coordinatorCallbackJob("job-callback-1", "first result"),
		coordinatorCallbackJob("job-callback-2", "second result"),
	}}
	runs := &coordinatorFakeRuns{runs: map[string]*agent.RunInfo{}}
	recBus := &coordinatorRecordingBus{}
	c := newCoordinatorTestHarness(jobs, runs, recBus, nil)

	c.launchCallbacks(context.Background())

	if got, want := jobs.callbackRunning, []string{"job-callback-1"}; !sameStrings(got, want) {
		t.Fatalf("callbackRunning = %v, want %v", got, want)
	}
	if len(recBus.publishes) != 1 || recBus.publishes[0].topic != dispatchTopic("agent-a") {
		t.Fatalf("publishes = %+v, want one callback dispatch to agent-a", recBus.publishes)
	}
	payload := decodeDispatchPayload(t, recBus.publishes[0].msg)
	if payload.InvocationKind != agent.InvocationCallback || payload.JobID != "job-callback-1" {
		t.Fatalf("payload = %+v, want callback for first job", payload)
	}
	if payload.OriginatorRunID != "origin-run" || payload.ParentRunID != "parent-run" {
		t.Fatalf("callback lineage = (%q,%q), want origin-run,parent-run", payload.OriginatorRunID, payload.ParentRunID)
	}
	if payload.SystemContext == "" {
		t.Fatal("callback SystemContext is empty")
	}
}

func TestJobCoordinatorResumeReadyRunPublishesResume(t *testing.T) {
	jobs := &coordinatorFakeJobs{readyRuns: []string{"parent-run"}}
	runs := &coordinatorFakeRuns{runs: map[string]*agent.RunInfo{
		"parent-run": {
			RunID:           "parent-run",
			ThreadID:        "parent-thread",
			AgentID:         "agent-a",
			UserID:          "user-1",
			Status:          string(model.RunStatusWaitingJobs),
			Attempt:         2,
			OriginatorRunID: "origin-run",
			InvocationKind:  agent.InvocationTopLevel,
		},
	}}
	recBus := &coordinatorRecordingBus{}
	c := newCoordinatorTestHarness(jobs, runs, recBus, nil)

	c.resumeReadyRuns(context.Background())

	if got, want := runs.transitions, []string{"parent-run:waiting_for_jobs->running"}; !sameStrings(got, want) {
		t.Fatalf("transitions = %v, want %v", got, want)
	}
	if runs.runs["parent-run"].Attempt != 3 {
		t.Fatalf("attempt = %d, want 3", runs.runs["parent-run"].Attempt)
	}
	if len(recBus.publishes) != 1 || recBus.publishes[0].topic != dispatchTopic("agent-a") {
		t.Fatalf("publishes = %+v, want one resume dispatch to agent-a", recBus.publishes)
	}
	payload := decodeDispatchPayload(t, recBus.publishes[0].msg)
	if !payload.IsResume || payload.Attempt != 3 || payload.RunID != "parent-run" {
		t.Fatalf("payload = %+v, want resume attempt 3 for parent-run", payload)
	}
}

func newCoordinatorTestHarness(jobs *coordinatorFakeJobs, runs *coordinatorFakeRuns, b *coordinatorRecordingBus, tasks *coordinatorFakeTasks) *JobCoordinator {
	if jobs.runningTargets == nil {
		jobs.runningTargets = make(map[string]bool)
	}
	if jobs.runningCallbacks == nil {
		jobs.runningCallbacks = make(map[string]bool)
	}
	if runs.runs == nil {
		runs.runs = make(map[string]*agent.RunInfo)
	}
	if b == nil {
		b = &coordinatorRecordingBus{}
	}
	pools := &PoolManager{pools: map[string]*AgentPool{
		"agent-a": {},
		"agent-b": {},
		"agent-c": {},
	}}
	return NewJobCoordinator(JobCoordinatorConfig{
		Bus:               b,
		Pools:             pools,
		Threads:           &coordinatorFakeThreads{},
		Runs:              runs,
		Jobs:              jobs,
		Tasks:             tasks,
		WorkerID:          "coordinator-test",
		ConcurrentJobs:    5,
		JobLease:          time.Second,
		JobLockLease:      time.Second,
		CallbackLockLease: time.Second,
		ReclaimGrace:      100 * time.Millisecond,
	})
}

func coordinatorQueuedJob(jobID, target string) model.JobDocument {
	now := time.Now()
	return model.JobDocument{
		JobID:           jobID,
		ParentRunID:     "parent-run",
		OriginatorRunID: "origin-run",
		ParentThreadID:  "parent-thread",
		ParentAgentID:   "agent-a",
		UserID:          "user-1",
		ToolCallID:      "dispatch-" + jobID,
		DelegateTool:    "ask_" + target,
		TargetAgentID:   target,
		Task:            "task for " + jobID,
		Mode:            agent.JobModeRequired,
		DelegationChain: []string{"agent-a"},
		Status:          string(model.JobStatusQueued),
		CallbackStatus:  string(model.CallbackStatusNone),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func coordinatorRunningJob(jobID, target, childRunID string) model.JobDocument {
	doc := coordinatorQueuedJob(jobID, target)
	doc.Status = string(model.JobStatusRunning)
	doc.ChildRunID = childRunID
	doc.ChildThreadID = "sub-origin-run-" + target
	return doc
}

func coordinatorCallbackJob(jobID, output string) model.JobDocument {
	doc := coordinatorQueuedJob(jobID, "agent-b")
	doc.Mode = agent.JobModeBackground
	doc.Status = string(model.JobStatusSucceeded)
	doc.Output = output
	doc.CallbackStatus = string(model.CallbackStatusQueued)
	doc.FinishedAt = time.Now()
	return doc
}

type coordinatorFakeJobs struct {
	queue            []model.JobDocument
	active           int64
	runningTargets   map[string]bool
	expiredJobs      []model.JobDocument
	expiredCallbacks []model.JobDocument
	expiredBefore    time.Time
	callbackBefore   time.Time
	readyRuns        []string
	callbacks        []model.JobDocument
	runningCallbacks map[string]bool

	claimed           []string
	dispatched        []string
	failed            []string
	cancelled         []string
	callbackRunning   []string
	callbackFailed    []string
	callbackCancelled []string
}

func (f *coordinatorFakeJobs) FindQueueCandidates(context.Context, int) ([]model.JobDocument, error) {
	return append([]model.JobDocument(nil), f.queue...), nil
}
func (f *coordinatorFakeJobs) CountActiveForOriginator(context.Context, string) (int64, error) {
	return f.active, nil
}
func (f *coordinatorFakeJobs) FindExpiredRunningJobs(_ context.Context, before time.Time, _ int) ([]model.JobDocument, error) {
	f.expiredBefore = before
	return append([]model.JobDocument(nil), f.expiredJobs...), nil
}
func (f *coordinatorFakeJobs) FindExpiredRunningCallbacks(_ context.Context, before time.Time, _ int) ([]model.JobDocument, error) {
	f.callbackBefore = before
	return append([]model.JobDocument(nil), f.expiredCallbacks...), nil
}
func (f *coordinatorFakeJobs) HasRunningTargetJob(_ context.Context, originatorRunID, targetAgentID, _ string) (bool, error) {
	return f.runningTargets[originatorRunID+"\x00"+targetAgentID], nil
}
func (f *coordinatorFakeJobs) HasRunningCallback(_ context.Context, parentThreadID, _ string) (bool, error) {
	return f.runningCallbacks[parentThreadID], nil
}
func (f *coordinatorFakeJobs) AcquireLock(context.Context, string, string, string, string, string, time.Duration) (bool, error) {
	return true, nil
}
func (f *coordinatorFakeJobs) ReleaseLock(context.Context, string, string) error { return nil }
func (f *coordinatorFakeJobs) ClaimJobStarting(_ context.Context, jobID, _ string, _ time.Duration) (model.JobDocument, bool, error) {
	for _, doc := range f.queue {
		if doc.JobID == jobID {
			f.claimed = append(f.claimed, jobID)
			doc.Status = string(model.JobStatusStarting)
			return doc, true, nil
		}
	}
	return model.JobDocument{}, false, nil
}
func (f *coordinatorFakeJobs) MarkJobDispatched(_ context.Context, jobID, _, _ string) error {
	f.dispatched = append(f.dispatched, jobID)
	if doc, ok := f.findJob(jobID); ok {
		f.runningTargets[doc.OriginatorRunID+"\x00"+doc.TargetAgentID] = true
	}
	return nil
}
func (f *coordinatorFakeJobs) MarkJobFailed(_ context.Context, jobID, _ string) error {
	f.failed = append(f.failed, jobID)
	return nil
}
func (f *coordinatorFakeJobs) MarkJobCancelled(_ context.Context, jobID, _ string) error {
	f.cancelled = append(f.cancelled, jobID)
	return nil
}
func (f *coordinatorFakeJobs) FindReadyWaitingRunIDs(context.Context, int) ([]string, error) {
	return append([]string(nil), f.readyRuns...), nil
}
func (f *coordinatorFakeJobs) FindQueuedCallbacks(context.Context, int) ([]model.JobDocument, error) {
	return append([]model.JobDocument(nil), f.callbacks...), nil
}
func (f *coordinatorFakeJobs) MarkCallbackRunning(_ context.Context, jobID, _ string, _ string, _ time.Duration) error {
	f.callbackRunning = append(f.callbackRunning, jobID)
	if doc, ok := f.findCallback(jobID); ok {
		f.runningCallbacks[doc.ParentThreadID] = true
	}
	return nil
}
func (f *coordinatorFakeJobs) MarkCallbackFailed(_ context.Context, jobID, _ string) error {
	f.callbackFailed = append(f.callbackFailed, jobID)
	return nil
}
func (f *coordinatorFakeJobs) MarkCallbackCancelled(_ context.Context, jobID, _ string) error {
	f.callbackCancelled = append(f.callbackCancelled, jobID)
	return nil
}
func (f *coordinatorFakeJobs) findJob(jobID string) (model.JobDocument, bool) {
	for _, doc := range f.queue {
		if doc.JobID == jobID {
			return doc, true
		}
	}
	for _, doc := range f.expiredJobs {
		if doc.JobID == jobID {
			return doc, true
		}
	}
	return model.JobDocument{}, false
}
func (f *coordinatorFakeJobs) findCallback(jobID string) (model.JobDocument, bool) {
	for _, doc := range f.callbacks {
		if doc.JobID == jobID {
			return doc, true
		}
	}
	return model.JobDocument{}, false
}

type coordinatorFakeRuns struct {
	runs        map[string]*agent.RunInfo
	created     []string
	statuses    []string
	transitions []string
}

func (f *coordinatorFakeRuns) CreateChildRunWithKind(_ context.Context, runID, threadID, agentID, userID, originatorRunID, parentRunID, invocationKind, jobID string) error {
	f.created = append(f.created, runID+":"+invocationKind+":"+jobID)
	f.runs[runID] = &agent.RunInfo{
		RunID:           runID,
		ThreadID:        threadID,
		AgentID:         agentID,
		UserID:          userID,
		Status:          string(model.RunStatusRunning),
		OriginatorRunID: originatorRunID,
		ParentRunID:     parentRunID,
		InvocationKind:  invocationKind,
		JobID:           jobID,
		Attempt:         1,
	}
	return nil
}
func (f *coordinatorFakeRuns) UpdateStatus(_ context.Context, runID, status, _ string) error {
	f.statuses = append(f.statuses, runID+":"+status)
	if info := f.runs[runID]; info != nil {
		info.Status = status
	}
	return nil
}
func (f *coordinatorFakeRuns) TransitionStatus(_ context.Context, runID, from, to string) (bool, error) {
	info := f.runs[runID]
	if info == nil || info.Status != from {
		return false, nil
	}
	info.Status = to
	f.transitions = append(f.transitions, runID+":"+from+"->"+to)
	return true, nil
}
func (f *coordinatorFakeRuns) IncrementAttempt(_ context.Context, runID string) (int, error) {
	info := f.runs[runID]
	if info == nil {
		return 0, nil
	}
	info.Attempt++
	return info.Attempt, nil
}
func (f *coordinatorFakeRuns) GetRun(_ context.Context, runID string) (*agent.RunInfo, error) {
	return f.runs[runID], nil
}

type coordinatorFakeThreads struct{}

func (f *coordinatorFakeThreads) Create(context.Context, string, string, string) (*agent.ThreadRecord, error) {
	return nil, nil
}
func (f *coordinatorFakeThreads) GetByID(context.Context, string, string) (*agent.ThreadRecord, error) {
	return nil, nil
}
func (f *coordinatorFakeThreads) ListByAgent(context.Context, string, string) ([]*agent.ThreadRecord, error) {
	return nil, nil
}
func (f *coordinatorFakeThreads) UpdateSummary(context.Context, string, string, string) error {
	return nil
}
func (f *coordinatorFakeThreads) FindOrCreateSubThread(_ context.Context, _, originatorRunID, agentID string) (string, error) {
	return "sub-" + originatorRunID + "-" + agentID, nil
}

type coordinatorFakeTasks struct {
	cancelled map[string]bool
}

func (f *coordinatorFakeTasks) IsCancelled(_ context.Context, originatorRunID string) (bool, error) {
	return f != nil && f.cancelled[originatorRunID], nil
}
func (f *coordinatorFakeTasks) CancelTask(context.Context, string, string) error { return nil }

type coordinatorRecordingBus struct {
	publishes []recordedPublish
}

type recordedPublish struct {
	topic string
	msg   bus.Message
}

func (b *coordinatorRecordingBus) Publish(_ context.Context, topic string, msg bus.Message, _ ...bus.PublishOption) error {
	b.publishes = append(b.publishes, recordedPublish{topic: topic, msg: msg})
	return nil
}
func (b *coordinatorRecordingBus) Subscribe(context.Context, string, ...bus.SubscribeOption) (bus.Subscription, error) {
	panic("Subscribe is not used by JobCoordinator tests")
}
func (b *coordinatorRecordingBus) Request(context.Context, string, bus.Message, time.Duration) (bus.Message, error) {
	panic("Request is not used by JobCoordinator tests")
}
func (b *coordinatorRecordingBus) Close() error { return nil }

func decodeDispatchPayload(t *testing.T, msg bus.Message) DispatchPayload {
	t.Helper()
	var payload DispatchPayload
	if err := json.Unmarshal(msg.Body, &payload); err != nil {
		t.Fatalf("decode dispatch payload: %v", err)
	}
	return payload
}

func findRecordedPublish(t *testing.T, publishes []recordedPublish, topic string) recordedPublish {
	t.Helper()
	for _, publish := range publishes {
		if publish.topic == topic {
			return publish
		}
	}
	t.Fatalf("publish to %q not found in %+v", topic, publishes)
	return recordedPublish{}
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
