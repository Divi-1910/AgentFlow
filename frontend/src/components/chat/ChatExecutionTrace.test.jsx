import { createStore, Provider } from 'jotai'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { chatRuntimeAtom } from '../../store/atoms/chatAtoms'
import ChatExecutionTrace from './ChatExecutionTrace'

describe('ChatExecutionTrace', () => {
  it('shows curated model and tool input/output inside expandable steps', async () => {
    const user = userEvent.setup()
    const store = createStore()
    store.set(chatRuntimeAtom, {
      connection: 'closed',
      error: null,
      events: [],
      lastEventId: '',
      partial: false,
      requiresReconcile: false,
      rootRunId: 'run-1',
      seen: {},
      status: 'completed',
      streams: {},
    })
    const messages = [
      { id: 'user', role: 'user', run_id: 'run-1', content: 'Remember that I prefer concise answers.' },
      {
        id: 'assistant-tools', role: 'assistant', run_id: 'run-1', content: '',
        tool_calls: [{ id: 'call-1', name: 'memory_write', arguments: { content: 'Prefers concise answers' } }],
      },
      {
        id: 'tool', role: 'tool', run_id: 'run-1', tool_call_id: 'call-1', tool_name: 'memory_write', content: 'saved',
        metadata: {
          presentation: {
            completed_label: 'Saved this to memory',
            input: [{ label: 'Content', value: 'Prefers concise answers' }],
            output: [{ label: 'Result', value: 'saved' }],
          },
        },
      },
      { id: 'final', role: 'assistant', run_id: 'run-1', content: 'I will remember that.' },
    ]

    render(
      <Provider store={store}>
        <ChatExecutionTrace messages={messages} onClose={vi.fn()} run={{ id: 'run-1' }} />
      </Provider>,
    )

    expect(screen.getByText('Saved this to memory')).toBeTruthy()
    const detailToggles = screen.getAllByText('Inspect input and output')
    await user.click(detailToggles[1])
    expect(screen.getByText('Tool input')).toBeTruthy()
    expect(screen.getByText('Prefers concise answers')).toBeTruthy()
    expect(screen.getByText('Tool output')).toBeTruthy()
    expect(screen.getByText('saved')).toBeTruthy()
    expect(screen.getByText(/private headers/)).toBeTruthy()
  })
})
