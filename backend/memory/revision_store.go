package memory

import (
	"context"
	"sync"
)

type InMemoryRevisionStore struct {
	mu         sync.Mutex
	byLineage  map[string][]MemoryRevision
	byMutation map[string]MemoryRevision
}

func NewInMemoryRevisionStore() *InMemoryRevisionStore {
	return &InMemoryRevisionStore{
		byLineage:  make(map[string][]MemoryRevision),
		byMutation: make(map[string]MemoryRevision),
	}
}

func (s *InMemoryRevisionStore) Append(_ context.Context, rev MemoryRevision) (*MemoryRevision, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.byMutation[rev.MutationID]; ok {
		if existing.LineageKey == rev.LineageKey {
			cp := existing
			return &cp, true, nil
		}
		return nil, false, ErrRevisionConflict
	}
	revs := s.byLineage[rev.LineageKey]
	for _, existing := range revs {
		if existing.Revision == rev.Revision {
			return nil, false, ErrRevisionConflict
		}
	}
	cp := rev
	s.byLineage[rev.LineageKey] = append(revs, cp)
	s.byMutation[rev.MutationID] = cp
	return &cp, false, nil
}

func (s *InMemoryRevisionStore) FindByMutation(_ context.Context, mutationID string) (*MemoryRevision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rev, ok := s.byMutation[mutationID]
	if !ok {
		return nil, nil
	}
	cp := rev
	return &cp, nil
}

func (s *InMemoryRevisionStore) Latest(_ context.Context, lineageKey string) (*MemoryRevision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	revs := s.byLineage[lineageKey]
	if len(revs) == 0 {
		return nil, nil
	}
	latest := revs[0]
	for _, rev := range revs[1:] {
		if rev.Revision > latest.Revision {
			latest = rev
		}
	}
	cp := latest
	return &cp, nil
}

func (s *InMemoryRevisionStore) FindRevision(_ context.Context, lineageKey string, revision int) (*MemoryRevision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rev := range s.byLineage[lineageKey] {
		if rev.Revision == revision {
			cp := rev
			return &cp, nil
		}
	}
	return nil, nil
}

func (s *InMemoryRevisionStore) List(_ context.Context, lineageKey string) ([]MemoryRevision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	revs := s.byLineage[lineageKey]
	out := make([]MemoryRevision, len(revs))
	copy(out, revs)
	return out, nil
}

func (s *InMemoryRevisionStore) EnsureIndexes(_ context.Context) error { return nil }
