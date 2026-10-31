import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentEditorData } from '../hooks/useAgentEditorData'
import { useApiClient } from '../hooks/useApiClient'
import { agentToolGroups } from '../features/agents/agentForgeGraph'
import AgentEditorPage from './AgentEditorPage'
import AgentWorkspaceLayout from '../components/agents/AgentWorkspaceLayout'

vi.mock('../hooks/useAgentEditorData', () => ({ useAgentEditorData: vi.fn() }))
vi.mock('../hooks/useApiClient', () => ({ useApiClient: vi.fn() }))
vi.mock('../components/agents/AgentForgeCanvas', () => ({
  default: ({ form, interactionDisabled, onOpenInspector }) => (
    <div data-disabled={interactionDisabled ? 'true' : 'false'} data-testid="agent-forge-canvas">
      <span>{form.name || 'Untitled agent'}</span>
      <output data-testid="selected-tools">{form.tools.join(',')}</output>
      <button type="button" onClick={onOpenInspector}>Configure {form.name || 'untitled agent'}</button>
    </div>
  ),
}))

const catalogs = {
  mcpServers: [{
    alias: 'fetch',
    description: 'Fetches web content.',
    name: 'Fetch',
    server_id: 'fetch',
  }],
  models: [{
    api_model_id: 'gpt-5.6-luna',
    available: true,
    context_window: 128000,
    model_id: 'openai:gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'openai',
  }],
  tools: [{
    available: true,
    description: 'Searches the web.',
    name: 'web_search',
    parameters: {},
  }, ...agentToolGroups.flatMap((group) => group.tools.map((name) => ({
    available: true,
    description: `${group.label} operation.`,
    name,
    parameters: {},
  })))],
}

const savedAgent = {
  context_keep_ratio: 0.5,
  context_window: 8,
  description: 'Researches technical topics.',
  id: 'agent-1',
  max_runs: 4,
  max_steps: 12,
  max_tokens: 2048,
  mcp_servers: [{ server_id: 'fetch' }],
  model: 'gpt-5.6-luna',
  name: 'Research Analyst',
  provider: 'openai',
  summarization_model: '',
  system_prompt: 'Research carefully.',
  temperature: 0.4,
  tools: ['web_search'],
}

function editorState(agent = null) {
  return {
    ...catalogs,
    agent,
    error: null,
    loading: false,
    reload: vi.fn(),
  }
}

function renderEditor(path, state) {
  const [pathname, query = ''] = path.split('?')
  const entry = state
    ? { pathname, search: query ? `?${query}` : '', state }
    : path
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents" element={<AgentWorkspaceLayout />}>
          <Route index element={<LibraryDestination />} />
          <Route path="new" element={<AgentEditorPage />} />
          <Route path=":agentId" element={<AgentEditorPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

function LibraryDestination() {
  const location = useLocation()
  return <output data-testid="library-route-state">{JSON.stringify(location.state)}</output>
}

async function openInspector(user, name = 'untitled agent') {
  await user.click(screen.getByRole('button', { name: `Configure ${name}` }))
}

describe('AgentEditorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates an agent with catalog tool and MCP selections', async () => {
    const post = vi.fn().mockResolvedValue(savedAgent)
    useApiClient.mockReturnValue({ patch: vi.fn(), post })
    useAgentEditorData.mockReturnValue(editorState())
    renderEditor('/agents/new')

    const user = userEvent.setup()
    await openInspector(user)
    await user.type(screen.getByLabelText('Name'), 'Research Analyst')
    await user.type(screen.getByLabelText('Description'), 'Researches technical topics.')
    await user.click(screen.getByRole('tab', { name: 'Model' }))
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai')
    await user.selectOptions(screen.getByLabelText('Primary model'), 'gpt-5.6-luna')
    await user.click(screen.getByRole('tab', { name: 'Capabilities' }))
    await user.click(screen.getByRole('checkbox', { name: /web_search/ }))
    await user.click(screen.getByRole('checkbox', { name: /Fetch/ }))
    await user.click(screen.getByRole('tab', { name: 'Instructions' }))
    await user.type(screen.getByLabelText('System prompt'), 'Research carefully.')
    await user.click(screen.getByRole('button', { name: 'Create agent' }))

    await waitFor(() => expect(post).toHaveBeenCalledOnce())
    expect(post).toHaveBeenCalledWith('/agents', {
      description: 'Researches technical topics.',
      mcp_servers: [{ server_id: 'fetch' }],
      model: 'gpt-5.6-luna',
      name: 'Research Analyst',
      provider: 'openai',
      system_prompt: 'Research carefully.',
      tools: ['web_search'],
    })

    const routeState = JSON.parse((await screen.findByTestId('library-route-state')).textContent)
    expect(routeState.animateLibraryEntry).toBe(true)
    expect(routeState.libraryPreview.selectedId).toBe(savedAgent.id)
    expect(routeState.libraryPreview.agents).toEqual([savedAgent])
  })

  it('patches only the field changed by the user', async () => {
    const updated = { ...savedAgent, description: 'Updated description' }
    const patch = vi.fn().mockResolvedValue(updated)
    useApiClient.mockReturnValue({ patch, post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState(savedAgent))
    renderEditor('/agents/agent-1')

    const user = userEvent.setup()
    await openInspector(user, 'Research Analyst')
    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'Updated description')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(patch).toHaveBeenCalledOnce())
    expect(patch).toHaveBeenCalledWith('/agents/agent-1', {
      description: 'Updated description',
    })
  })

  it('opens the tabbed inspector from the agent and preserves draft state after closing it', async () => {
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState())
    renderEditor('/agents/new')

    const user = userEvent.setup()
    expect(screen.queryByRole('complementary', { name: 'Agent configuration inspector' })).toBeNull()

    await openInspector(user)
    await user.type(screen.getByLabelText('Name'), 'Persistent draft')
    await user.click(screen.getByRole('button', { name: 'Close agent inspector' }))
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull())

    await openInspector(user, 'Persistent draft')
    expect(screen.getByLabelText('Name').value).toBe('Persistent draft')
  })

  it('presents memory as one checkbox and expands it to the backend operation names', async () => {
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState())
    renderEditor('/agents/new')

    const user = userEvent.setup()
    await openInspector(user)
    await user.click(screen.getByRole('tab', { name: 'Capabilities' }))
    await user.click(screen.getByRole('checkbox', { name: /Memory/ }))

    const memory = agentToolGroups.find((group) => group.id === 'memory')
    expect(screen.getByTestId('selected-tools').textContent).toBe(memory.tools.join(','))
    expect(screen.queryByRole('checkbox', { name: /memory_write/ })).toBeNull()
  })

  it('shows a partial saved group without silently changing it, then completes it on click', async () => {
    const memory = agentToolGroups.find((group) => group.id === 'memory')
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState({ ...savedAgent, tools: [memory.tools[0]] }))
    renderEditor('/agents/agent-1')

    const user = userEvent.setup()
    await openInspector(user, 'Research Analyst')
    await user.click(screen.getByRole('tab', { name: 'Capabilities' }))

    const memoryCheckbox = screen.getByRole('checkbox', { name: /Memory/ })
    expect(memoryCheckbox.getAttribute('aria-checked')).toBe('mixed')
    expect(screen.getByTestId('selected-tools').textContent).toBe(memory.tools[0])

    await user.click(memoryCheckbox)
    expect(screen.getByTestId('selected-tools').textContent).toBe(memory.tools.join(','))
  })

  it('opens the inspector and focuses the first invalid field when creation validation fails', async () => {
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState())
    renderEditor('/agents/new')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create agent' }))

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')))
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows a non-editable route preview while authoritative agent data loads', () => {
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue({
      ...catalogs,
      agent: null,
      error: null,
      loading: true,
      reload: vi.fn(),
    })

    renderEditor('/agents/agent-1', {
      agentPreview: savedAgent,
      mcpServersPreview: catalogs.mcpServers,
      toolsPreview: catalogs.tools,
    })

    expect(screen.getByTestId('agent-forge-canvas').textContent).toContain('Research Analyst')
    expect(screen.getByTestId('agent-forge-canvas').getAttribute('data-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Save changes' }).disabled).toBe(true)
  })

  it('shows the blank create canvas while authoritative catalogs load', () => {
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue({
      ...catalogs,
      agent: null,
      error: null,
      loading: true,
      reload: vi.fn(),
    })

    renderEditor('/agents/new', {
      createPreview: true,
      mcpServersPreview: catalogs.mcpServers,
      toolsPreview: catalogs.tools,
    })

    expect(screen.getByTestId('agent-forge-canvas').textContent).toContain('Untitled agent')
    expect(screen.getByTestId('agent-forge-canvas').getAttribute('data-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Create agent' }).disabled).toBe(true)
  })

  it('returns through the animated library entry while preserving the library snapshot', async () => {
    useApiClient.mockReturnValue({ patch: vi.fn(), post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState(savedAgent))
    const libraryPreview = {
      agents: [savedAgent],
      mcpServers: catalogs.mcpServers,
      selectedId: savedAgent.id,
      tools: catalogs.tools,
    }
    renderEditor('/agents/agent-1?panel=agent&tab=overview', { libraryPreview })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Back to agent library' }))

    const routeState = await screen.findByTestId('library-route-state')
    expect(JSON.parse(routeState.textContent)).toEqual({
      animateLibraryEntry: true,
      libraryPreview,
    })
  })

  it('returns the saved agent in the preserved library snapshot', async () => {
    const updatedAgent = { ...savedAgent, description: 'Updated description' }
    const patch = vi.fn().mockResolvedValue(updatedAgent)
    useApiClient.mockReturnValue({ patch, post: vi.fn() })
    useAgentEditorData.mockReturnValue(editorState(savedAgent))
    const libraryPreview = {
      agents: [savedAgent],
      mcpServers: catalogs.mcpServers,
      selectedId: savedAgent.id,
      tools: catalogs.tools,
    }
    renderEditor('/agents/agent-1?panel=agent&tab=overview', { libraryPreview })

    const user = userEvent.setup()
    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'Updated description')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(patch).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: 'Back to agent library' }))

    const routeState = JSON.parse((await screen.findByTestId('library-route-state')).textContent)
    expect(routeState.libraryPreview.agents).toEqual([updatedAgent])
  })
})
