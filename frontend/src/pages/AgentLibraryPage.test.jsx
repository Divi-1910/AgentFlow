import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { useAgentLibrary } from '../hooks/useAgentLibrary'
import { useApiClient } from '../hooks/useApiClient'
import AgentLibraryPage from './AgentLibraryPage'
import AgentWorkspaceLayout from '../components/agents/AgentWorkspaceLayout'

vi.mock('../hooks/useAgentLibrary', () => ({ useAgentLibrary: vi.fn() }))
vi.mock('../hooks/useApiClient', () => ({ useApiClient: vi.fn() }))
vi.mock('../components/agents/AgentForgeCanvas', () => ({
  default: ({ form, mode, onSceneTransitionComplete, scenePhase }) => (
    <div>
      <div data-mode={mode} data-phase={scenePhase} data-testid="agent-core">{form.name}</div>
      <button
        type="button"
        disabled={scenePhase === 'idle'}
        onClick={() => onSceneTransitionComplete?.(scenePhase)}
      >
        Complete canvas scene
      </button>
    </div>
  ),
}))

const agents = [
  {
    id: 'agent-1',
    mcp_servers: [{ server_id: 'fetch' }],
    model: 'gpt-5.6-luna',
    name: 'Research Analyst',
    provider: 'openai',
    tools: ['web_search'],
  },
  {
    id: 'agent-2',
    mcp_servers: [],
    model: 'gpt-4o',
    name: 'Weather Assistant',
    provider: 'openai',
    tools: [],
  },
]

function renderPage(entry = '/agents') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents" element={<AgentWorkspaceLayout />}>
          <Route index element={<AgentLibraryPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('AgentLibraryPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useApiClient.mockReturnValue({ delete: vi.fn() })
    useAgentLibrary.mockReturnValue({
      agents,
      error: null,
      loading: false,
      mcpServers: [{ server_id: 'fetch', name: 'Fetch' }],
      reload: vi.fn(),
      tools: [{ available: true, name: 'web_search' }],
    })
  })

  it('exits the previous constellation before entering the selected agent', async () => {
    renderPage()

    expect(screen.getByTestId('agent-core').textContent).toBe('Research Analyst')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Select Weather Assistant' }))

    expect(screen.getByRole('button', { name: 'Select Weather Assistant' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('agent-core').textContent).toBe('Research Analyst')
    expect(screen.getByTestId('agent-core').getAttribute('data-phase')).toBe('exiting')

    await user.click(screen.getByRole('button', { name: 'Complete canvas scene' }))
    expect(screen.getByTestId('agent-core').textContent).toBe('Weather Assistant')
    expect(screen.getByTestId('agent-core').getAttribute('data-phase')).toBe('entering')

    await user.click(screen.getByRole('button', { name: 'Complete canvas scene' }))
    expect(screen.getByTestId('agent-core').getAttribute('data-phase')).toBe('idle')
  })

  it('recovers when the canvas does not report animation completion', async () => {
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Select Weather Assistant' }))
    expect(screen.getByTestId('agent-core').getAttribute('data-phase')).toBe('exiting')

    await waitFor(() => {
      expect(screen.getByTestId('agent-core').textContent).toBe('Weather Assistant')
      expect(screen.getByTestId('agent-core').getAttribute('data-phase')).toBe('idle')
    }, { timeout: 1500 })
  })

  it('targets the editable inspector when configuring the selected agent', () => {
    renderPage()

    expect(screen.getByRole('link', { name: 'Configure' }).getAttribute('href'))
      .toBe('/agents/agent-1?panel=agent&tab=overview')
  })

  it('shows backend dependencies when deletion is blocked', async () => {
    const deleteAgent = vi.fn().mockRejectedValue(new ApiError(
      'resource cannot be deleted while it has dependencies',
      { status: 409, data: { dependencies: ['threads', 'publications'] } },
    ))
    useApiClient.mockReturnValue({ delete: deleteAgent })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect((await screen.findByRole('alert')).textContent).toContain('conversations, published revisions')
  })

  it('renders a useful empty state', () => {
    useAgentLibrary.mockReturnValue({
      agents: [], error: null, loading: false, mcpServers: [], reload: vi.fn(), tools: [],
    })
    renderPage()

    expect(screen.getByRole('heading', { name: 'Build your first intelligence' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Create agent' }).getAttribute('href'))
      .toBe('/agents/new?panel=agent&tab=overview')
  })

  it('uses the preserved library snapshot during the return fetch', () => {
    useAgentLibrary.mockReturnValue({
      agents: [], error: null, loading: true, mcpServers: [], reload: vi.fn(), tools: [],
    })

    renderPage({
      pathname: '/agents',
      state: {
        animateLibraryEntry: true,
        libraryPreview: {
          agents,
          mcpServers: [{ server_id: 'fetch', name: 'Fetch' }],
          selectedId: 'agent-2',
          tools: [{ available: true, name: 'web_search' }],
        },
      },
    })

    expect(screen.queryByLabelText('Loading agent library')).toBeNull()
    expect(screen.getByTestId('agent-core').textContent).toBe('Weather Assistant')
  })
})
