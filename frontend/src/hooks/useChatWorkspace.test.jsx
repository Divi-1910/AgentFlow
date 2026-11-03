import { Provider } from 'jotai'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatWorkspace } from './useChatWorkspace'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  stream: vi.fn(),
}))

vi.mock('./useApiClient', () => ({
  useApiClient: () => apiMocks,
}))

const agent = { id: 'agent-1', name: 'Research agent', resource_kind: 'standalone_agent' }
const threads = [
  { id: 'thread-a', resource_id: agent.id, title: 'First conversation', updated_at: '2026-10-30T12:00:00Z' },
  { id: 'thread-b', resource_id: agent.id, title: 'Second conversation', updated_at: '2026-10-30T11:00:00Z' },
]

let runItemsByThread
let jobItemsByThread
let messageItemsByThread

function eventStream(events) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`id: ${event.stream_id || ''}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

function wrapper(initialEntry) {
  return function ChatTestWrapper({ children }) {
    return (
      <Provider>
        <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
      </Provider>
    )
  }
}

describe('useChatWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runItemsByThread = {}
    jobItemsByThread = {}
    messageItemsByThread = {
      'thread-a': [{ id: 'message-a', role: 'assistant', content: 'First', created_at: '2026-10-30T12:01:00Z' }],
      'thread-b': [{ id: 'message-b', role: 'assistant', content: 'Second', created_at: '2026-10-30T11:01:00Z' }],
    }
    apiMocks.get.mockImplementation((path) => {
      if (path === '/threads?limit=200') return Promise.resolve({ items: threads })
      if (path === '/agents') return Promise.resolve([agent])
      if (path === '/agent-teams') return Promise.resolve([])
      const messageMatch = path.match(/^\/threads\/([^/]+)\/messages\?limit=200$/)
      if (messageMatch) return Promise.resolve({ items: messageItemsByThread[messageMatch[1]] || [] })
      const runMatch = path.match(/^\/threads\/([^/]+)\/runs\?limit=200$/)
      if (runMatch) return Promise.resolve({ items: runItemsByThread[runMatch[1]] || [] })
      const jobMatch = path.match(/^\/threads\/([^/]+)\/jobs\?limit=200$/)
      if (jobMatch) {
        const jobs = jobItemsByThread[jobMatch[1]]
        return Promise.resolve({ items: typeof jobs === 'function' ? jobs() : jobs || [] })
      }
      throw new Error(`Unexpected GET ${path}`)
    })
  })

  it('switches conversations without reloading the workspace or reverting to the initial URL selection', async () => {
    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe('thread-a')
      expect(result.current.messages[0]?.content).toBe('First')
    })

    act(() => result.current.selectThread(threads[1]))

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe('thread-b')
      expect(result.current.messages[0]?.content).toBe('Second')
    })

    expect(apiMocks.get.mock.calls.filter(([path]) => path === '/threads?limit=200')).toHaveLength(1)
  })

  it('starts a resource-scoped draft without recreating the workspace', async () => {
    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => expect(result.current.messages[0]?.content).toBe('First'))

    act(() => result.current.selectResource(agent))

    await waitFor(() => {
      expect(result.current.selectedThread).toBeNull()
      expect(result.current.selectedResource?.id).toBe(agent.id)
      expect(result.current.messages).toEqual([])
    })

    expect(apiMocks.get.mock.calls.filter(([path]) => path === '/threads?limit=200')).toHaveLength(1)
  })

  it('reconnects to an active durable run after a page refresh', async () => {
    runItemsByThread['thread-a'] = [{
      id: 'run-active', status: 'running', thread_id: 'thread-a', updated_at: '2026-10-30T12:02:00Z',
    }]
    apiMocks.stream.mockResolvedValue(eventStream([{
      originator_run_id: 'run-active', run_id: 'run-active', stream_id: 'run-active:8', type: 'run.completed',
    }]))

    renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => {
      expect(apiMocks.stream).toHaveBeenCalledWith('/runs/run-active/events', expect.objectContaining({ method: 'GET' }))
    })
  })

  it('restores durable background work after a page refresh', async () => {
    runItemsByThread['thread-a'] = [{
      id: 'run-background', status: 'completed', thread_id: 'thread-a', updated_at: '2026-10-30T12:02:00Z',
    }]
    jobItemsByThread['thread-a'] = [{
      callback_status: 'failed', id: 'job-1', mode: 'background', parent_run_id: 'run-background',
      status: 'succeeded', task: 'Research Mumbai weather', updated_at: '2026-10-30T12:03:00Z',
    }]

    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => {
      expect(result.current.backgroundJobs).toHaveLength(1)
      expect(result.current.backgroundJobs[0]).toMatchObject({ id: 'job-1', callback_status: 'failed' })
    })
  })

  it('loads a completed background callback into the transcript without a page refresh', async () => {
    runItemsByThread['thread-a'] = [{
      id: 'run-background', status: 'completed', thread_id: 'thread-a', updated_at: '2026-10-30T12:02:00Z',
    }]
    const pendingJob = {
      callback_status: 'queued', id: 'job-1', mode: 'background', parent_run_id: 'run-background',
      status: 'succeeded', task: 'Calculate 2 + 2', updated_at: '2026-10-30T12:03:00Z',
    }
    const completedJob = {
      ...pendingJob, callback_status: 'completed', updated_at: '2026-10-30T12:04:00Z',
    }
    let jobReads = 0
    jobItemsByThread['thread-a'] = () => {
      jobReads += 1
      if (jobReads === 1) return [pendingJob]
      messageItemsByThread['thread-a'] = [
        ...messageItemsByThread['thread-a'],
        { id: 'callback-message', role: 'assistant', content: '2 + 2 equals 4.', created_at: '2026-10-30T12:04:00Z' },
      ]
      return [completedJob]
    }

    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => {
      expect(result.current.messages.some((message) => message.id === 'callback-message')).toBe(true)
      expect(result.current.backgroundJobs).toEqual([completedJob])
    }, { timeout: 4000 })
  })

  it('cancels the durable active run through its run endpoint', async () => {
    runItemsByThread['thread-a'] = [{
      id: 'run-active', status: 'running', thread_id: 'thread-a', updated_at: '2026-10-30T12:02:00Z',
    }]
    apiMocks.stream.mockResolvedValue(eventStream([]))
    apiMocks.post.mockResolvedValue({ id: 'run-active', status: 'cancelling' })
    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => expect(result.current.latestRun?.id).toBe('run-active'))
    await act(async () => result.current.cancelRun())

    expect(apiMocks.post).toHaveBeenCalledWith('/runs/run-active/cancel')
    expect(result.current.latestRun?.status).toBe('cancelling')
  })

  it('resumes an interrupted checkpoint through the streaming resume endpoint', async () => {
    runItemsByThread['thread-a'] = [{
      id: 'run-resumable', resumable: true, status: 'interrupted', thread_id: 'thread-a', updated_at: '2026-10-30T12:02:00Z',
    }]
    apiMocks.stream.mockResolvedValue(eventStream([{
      originator_run_id: 'run-resumable', run_id: 'run-resumable', stream_id: 'run-resumable:9', type: 'run.completed',
    }]))
    const { result } = renderHook(() => useChatWorkspace(), {
      wrapper: wrapper('/chat?thread_id=thread-a'),
    })

    await waitFor(() => expect(result.current.latestRun?.status).toBe('interrupted'))
    await act(async () => result.current.resumeRun())

    expect(apiMocks.stream).toHaveBeenCalledWith(
      '/runs/run-resumable/resume',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
