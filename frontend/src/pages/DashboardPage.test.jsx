import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashboardData } from '../hooks/useDashboardData'
import DashboardPage from './DashboardPage'

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardData: vi.fn(),
}))

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  )
}

const dashboardData = {
  capabilities: {
    managed_deployments: true,
    runtime_proxy: true,
    studio_execution: true,
  },
  mcpServers: [{ server_id: 'fetch', name: 'Fetch' }],
  models: [{ api_model_id: 'gpt-test', available: true, name: 'Test model', provider: 'openai' }],
  overview: {
    catalog: {
      available_mcp_servers: 5,
      available_models: 18,
      available_tools: 3,
    },
    deployments: {
      degraded: 0,
      failed: 0,
      in_progress: 0,
      managed_enabled: true,
      ready: 2,
      total: 2,
    },
    resources: { agents: 4, teams: 1 },
    runs: { active: 1 },
  },
  runs: [
    {
      attempt: 1,
      id: 'run-1',
      resource: { name: 'Research team' },
      status: 'completed',
      steps_completed: 4,
    },
  ],
  threads: [
    {
      id: 'thread-1',
      resource: { name: 'Research team' },
      title: 'Compare deployment options',
      updated_at: '2026-10-24T10:30:00Z',
    },
  ],
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('announces the loading state', () => {
    useDashboardData.mockReturnValue({ data: null, error: null, loading: true, reload: vi.fn() })
    renderDashboard()

    expect(screen.getByLabelText('Loading workspace overview')).toBeTruthy()
  })

  it('renders backend workspace data', () => {
    useDashboardData.mockReturnValue({ data: dashboardData, error: null, loading: false, reload: vi.fn() })
    renderDashboard()

    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByText('Compare deployment options')).toBeTruthy()
    expect(screen.getAllByText('Research team')).toHaveLength(2)
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getByText('Studio execution')).toBeTruthy()
  })

  it('offers a working retry after a load failure', async () => {
    const reload = vi.fn()
    useDashboardData.mockReturnValue({
      data: null,
      error: new Error('Unable to reach AgentFlow.'),
      loading: false,
      reload,
    })
    renderDashboard()

    await userEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(reload).toHaveBeenCalledOnce()
  })
})
