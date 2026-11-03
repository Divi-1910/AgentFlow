import { createStore, Provider } from 'jotai'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { chatRuntimeAtom } from '../../store/atoms/chatAtoms'
import ChatTranscript from './ChatTranscript'

function renderTranscript(messageOrMessages, props = {}) {
  const store = createStore()
  store.set(chatRuntimeAtom, {
    connection: 'idle',
    error: null,
    events: [],
    lastEventId: '',
    partial: false,
    requiresReconcile: false,
    rootRunId: null,
    seen: {},
    status: 'completed',
    streams: {},
  })

  return render(
    <Provider store={store}>
      <ChatTranscript
        actionError={null}
        backgroundJobs={props.backgroundJobs || []}
        latestRun={null}
        messages={Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages]}
        onCancel={vi.fn()}
        onOpenTrace={vi.fn()}
        onReconnect={vi.fn()}
        onRename={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onSend={vi.fn()}
        resource={{ id: 'agent-1', name: 'Research agent', resource_kind: 'standalone_agent' }}
        retryable={false}
        submitting={false}
        thread={{ id: 'thread-1', title: 'Research', updated_at: '2026-10-30T12:00:00Z' }}
        threadLoading={false}
        traceOpen={false}
      />
    </Provider>,
  )
}

function renderRuntimeTranscript(runtime, messages = []) {
	const store = createStore()
	store.set(chatRuntimeAtom, runtime)
	return render(
		<Provider store={store}>
			<ChatTranscript
				actionError={null}
				latestRun={{ id: 'run-1', status: 'running' }}
				messages={messages}
				onCancel={vi.fn()}
				onOpenTrace={vi.fn()}
				onReconnect={vi.fn()}
				onRename={vi.fn()}
				onResume={vi.fn()}
				onRetry={vi.fn()}
				onSend={vi.fn()}
				resource={{ id: 'agent-1', name: 'Research agent', resource_kind: 'standalone_agent' }}
				retryable={false}
				submitting={false}
				thread={{ id: 'thread-1', title: 'Research' }}
				threadLoading={false}
				traceOpen={false}
			/>
		</Provider>,
	)
}

describe('ChatTranscript', () => {
	it('keeps durable background work visible after the primary stream closes', () => {
		renderTranscript({
			content: 'I started the research and will update you here.',
			created_at: '2026-10-30T12:01:00Z',
			id: 'message-1',
			role: 'assistant',
		}, {
			backgroundJobs: [{
				callback_status: 'queued', id: 'job-1', mode: 'background',
				status: 'running', task: 'Research Mumbai weather',
			}],
		})

		expect(screen.getByText('Working in background')).toBeTruthy()
		expect(screen.getByText('Research Mumbai weather')).toBeTruthy()
	})

  it('renders assistant Markdown instead of exposing formatting syntax', () => {
    const { container } = renderTranscript({
      content: 'Your father is **Ravindra**.\n\n- Remembered from memory',
      created_at: '2026-10-30T12:01:00Z',
      id: 'message-1',
      role: 'assistant',
    })

    expect(screen.getByText('Ravindra', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toContain('Remembered from memory')
    expect(container.textContent).not.toContain('**Ravindra**')
  })

  it('does not render raw HTML from model output', () => {
    const { container } = renderTranscript({
      content: '<script>window.compromised = true</script>\n\nSafe response',
      created_at: '2026-10-30T12:01:00Z',
      id: 'message-2',
      role: 'assistant',
    })

    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('Safe response')).toBeTruthy()
  })

	it('does not reserve message chrome for empty persisted records', () => {
    renderTranscript({
      content: '   ',
      created_at: '2026-10-30T12:01:00Z',
      id: 'message-3',
      role: 'assistant',
    })

    expect(screen.queryByText('AgentFlow', { selector: '.chat-message strong' })).toBeNull()
		expect(screen.getByText('Ask Research agent')).toBeTruthy()
	})

	it('shows an assistant turn before the first model token arrives', () => {
		const { container } = renderRuntimeTranscript({
			connection: 'streaming', error: null, events: [], lastEventId: 'run-1:0', partial: false,
			requiresReconcile: false, rootRunId: 'run-1', seen: {}, status: 'running', streams: {},
		}, [{ id: 'user-1', role: 'user', content: 'Help me', created_at: '2026-10-30T12:00:00Z' }])

		expect(screen.getByText('Thinking')).toBeTruthy()
		expect(screen.getByText('Research agent', { selector: '.chat-message header strong' })).toBeTruthy()
		expect(container.querySelector('.chat-caret')).toBeNull()
	})

	it('keeps completed capability details out of the transcript', () => {
		renderTranscript([
			{ id: 'user', role: 'user', run_id: 'run-1', content: 'Remember this', created_at: '2026-10-30T12:00:00Z' },
			{
				id: 'tool-call', role: 'assistant', run_id: 'run-1', content: '', created_at: '2026-10-30T12:00:01Z',
				tool_calls: [{ id: 'call-1', name: 'memory_write', arguments: { content: 'Remember this' } }],
			},
			{
				id: 'tool-result', role: 'tool', run_id: 'run-1', tool_call_id: 'call-1', tool_name: 'memory_write', content: 'saved',
				created_at: '2026-10-30T12:00:02Z', metadata: { presentation: { completed_label: 'Saved this to memory' } },
			},
			{ id: 'final', role: 'assistant', run_id: 'run-1', content: 'I will remember that.', created_at: '2026-10-30T12:00:03Z' },
		])

		expect(screen.queryByText('Saved this to memory')).toBeNull()
		expect(screen.getByRole('button', { name: 'Open complete activity' })).toBeTruthy()
	})
})
