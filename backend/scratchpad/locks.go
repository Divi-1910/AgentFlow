package scratchpad

import "sync"

// workspaceLocks serializes writers per workspace dir. In-process only — v1
// assumes all writers for one originator_run_id share one backend process
// (true today: in-proc bus + in-process pool workers/coordinator). A
// cross-process (mkdir/flock) lock is deferred to the out-of-process phase.
//
// TODO: bounded eviction — entries are never reclaimed (one tiny *sync.Mutex
// per distinct workspace for process lifetime); revisit with TTL cleanup.
type workspaceLocks struct{ m sync.Map }

func (w *workspaceLocks) lock(dir string) func() {
	actual, _ := w.m.LoadOrStore(dir, &sync.Mutex{})
	mu := actual.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
