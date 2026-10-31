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
    apiMocks.get.mockImplementation((path) => {
      if (path === '/threads?limit=200') return Promise.resolve({ items: threads })
      if (path === '/agents') return Promise.resolve([agent])
      if (path === '/agent-teams') return Promise.resolve([])
      if (path === '/threads/thread-a/messages?limit=200') {
        return Promise.resolve({ items: [{ id: 'message-a', role: 'assistant', content: 'First', created_at: '2026-10-30T12:01:00Z' }] })
      }
      if (path === '/threads/thread-b/messages?limit=200') {
        return Promise.resolve({ items: [{ id: 'message-b', role: 'assistant', content: 'Second', created_at: '2026-10-30T11:01:00Z' }] })
      }
      if (path.endsWith('/runs?limit=200')) return Promise.resolve({ items: [] })
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
})
