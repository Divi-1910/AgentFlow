import { describe, expect, it } from 'vitest'
import {
  chatRuntimeReducer,
  initialChatRuntimeState,
  selectPrimaryDraft,
} from './chatState'

function apply(events, seed = { ...initialChatRuntimeState }) {
  return events.reduce(
    (state, event) => chatRuntimeReducer(state, { type: 'event', event }),
    seed,
  )
}

describe('chat runtime reducer', () => {
  it('deduplicates delivery events and appends attempt-scoped model deltas', () => {
    const accepted = {
      type: 'run.accepted', run_id: 'root', originator_run_id: 'root', stream_id: 'root:0', status: 'running',
    }
    const delta = {
      type: 'model.delta', run_id: 'root', originator_run_id: 'root', stream_id: 'root:1', delta: 'Hello', attempt: 1,
    }
    const state = apply([accepted, delta, delta])

    expect(selectPrimaryDraft(state)?.content).toBe('Hello')
    expect(state.lastEventId).toBe('root:1')
  })

  it('batches streamed deltas without losing event identities or ordering', () => {
    const seed = chatRuntimeReducer(initialChatRuntimeState, { type: 'begin', runId: 'root' })
    const deltas = [
      { type: 'model.delta', run_id: 'root', stream_id: 'root:1', delta: 'Agent', attempt: 1 },
      { type: 'model.delta', run_id: 'root', stream_id: 'root:2', delta: 'Flow', attempt: 1 },
    ]
    const state = chatRuntimeReducer(seed, { type: 'event.batch', events: deltas })
    const replayed = chatRuntimeReducer(state, { type: 'event.batch', events: deltas })

    expect(selectPrimaryDraft(state)?.content).toBe('AgentFlow')
    expect(state.lastEventId).toBe('root:2')
    expect(replayed).toBe(state)
  })

  it('does not close the originator stream when a child run completes', () => {
    const seed = chatRuntimeReducer(initialChatRuntimeState, { type: 'begin', runId: 'root' })
    const state = apply([{
      type: 'run.completed', run_id: 'child', originator_run_id: 'root', stream_id: 'root:5', depth: 1,
    }], seed)

    expect(state.connection).toBe('streaming')
    expect(state.status).toBe('running')
  })

  it('marks root termination for durable reconciliation', () => {
    const seed = chatRuntimeReducer(initialChatRuntimeState, { type: 'begin', runId: 'root' })
    const state = apply([{
      type: 'run.completed', run_id: 'root', originator_run_id: 'root', stream_id: 'root:9',
    }], seed)

    expect(state.connection).toBe('closed')
    expect(state.status).toBe('completed')
    expect(state.requiresReconcile).toBe(true)
  })

	it('presents terminal content when a provider does not stream text deltas', () => {
		const seed = chatRuntimeReducer(initialChatRuntimeState, { type: 'begin', runId: 'root' })
		const state = apply([{
			type: 'run.completed', run_id: 'root', originator_run_id: 'root', stream_id: 'root:9', content: 'Complete response',
		}], seed)

		expect(selectPrimaryDraft(state)).toMatchObject({ complete: true, content: 'Complete response' })
	})

  it('requests durable state after a replay reset', () => {
    const state = apply([{
      type: 'stream.reset', run_id: 'root', originator_run_id: 'root', stream_id: 'root:12',
    }])

    expect(state.connection).toBe('resetting')
    expect(state.requiresReconcile).toBe(true)
  })
})
