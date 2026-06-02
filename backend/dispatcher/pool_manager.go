package dispatcher

import (
	"context"
	"fmt"
	"sync"
	"time"

	"backend/bus"
)

const defaultWorkerCount = 4

type PoolManager struct {
	rootCtx  context.Context
	bus      bus.MessageBus
	preparer *RunPreparer
	runtime  Runtime
	status   runStatusUpdater
	workers  int
	cancels  *CancelRegistry

	mu    sync.Mutex
	pools map[string]*AgentPool
}

type PoolManagerConfig struct {
	RootCtx   context.Context
	Bus       bus.MessageBus
	Preparer  *RunPreparer
	Runtime   Runtime
	Status    runStatusUpdater // run-status store for worker pre-RunStream bail paths
	Workers   int
	CancelTTL time.Duration // 0 → DefaultCancelTTL
}

func NewPoolManager(cfg PoolManagerConfig) *PoolManager {
	rootCtx := cfg.RootCtx
	if rootCtx == nil {
		rootCtx = context.Background()
	}
	workers := cfg.Workers
	if workers <= 0 {
		workers = defaultWorkerCount
	}
	return &PoolManager{
		rootCtx:  rootCtx,
		bus:      cfg.Bus,
		preparer: cfg.Preparer,
		runtime:  cfg.Runtime,
		status:   cfg.Status,
		workers:  workers,
		cancels:  NewCancelRegistry(cfg.CancelTTL),
		pools:    make(map[string]*AgentPool),
	}
}

func (m *PoolManager) Ensure(ctx context.Context, agentID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if agentID == "" {
		return fmt.Errorf("dispatcher: empty agent id")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.pools[agentID]; ok {
		return nil
	}

	pool := NewAgentPool(m.rootCtx, agentID, m.bus, m.preparer, m.runtime, m.status, m.workers, m.cancels)
	if err := pool.Start(); err != nil {
		return err
	}
	m.pools[agentID] = pool
	return nil
}

// CancelTask marks an originator run cancelled in the shared registry so that
// late-dispatched children in the same tree observe the cancellation.
func (m *PoolManager) CancelTask(originatorRunID string) {
	if m == nil || m.cancels == nil {
		return
	}
	m.cancels.Cancel(originatorRunID)
}

func (m *PoolManager) PoolCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pools)
}

func (m *PoolManager) StopAll() {
	m.mu.Lock()
	pools := make([]*AgentPool, 0, len(m.pools))
	for _, pool := range m.pools {
		pools = append(pools, pool)
	}
	m.pools = make(map[string]*AgentPool)
	m.mu.Unlock()

	for _, pool := range pools {
		pool.Stop()
	}
}
