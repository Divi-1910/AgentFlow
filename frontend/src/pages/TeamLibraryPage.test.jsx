import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TeamWorkspaceLayout from '../components/teams/TeamWorkspaceLayout'
import { useApiClient } from '../hooks/useApiClient'
import { useTeamLibrary } from '../hooks/useTeamLibrary'
import TeamLibraryPage from './TeamLibraryPage'

vi.mock('../hooks/useApiClient', () => ({ useApiClient: vi.fn() }))
vi.mock('../hooks/useTeamLibrary', () => ({ useTeamLibrary: vi.fn() }))
vi.mock('../components/teams/TeamGraphCanvas', () => ({
  default: ({ draft, onSceneTransitionComplete, scenePhase }) => (
    <div>
      <span data-phase={scenePhase} data-testid="team-canvas">{draft.name}</span>
      <button type="button" onClick={() => onSceneTransitionComplete?.(scenePhase)}>Complete team scene</button>
    </div>
  ),
}))

const agents = [
  { id: 'lead', model: 'gpt-5.6-luna', name: 'Lead', provider: 'openai', tools: [] },
  { id: 'writer', model: 'gpt-5.6-luna', name: 'Writer', provider: 'openai', tools: [] },
]
const teams = [
  {
    description: 'First graph', edges: [], entry_agent_id: 'lead', id: 'team-a', name: 'Alpha',
    nodes: [{ agent_id: 'lead', position: { x: 0, y: 0 } }],
  },
  {
    description: 'Second graph', edges: [], entry_agent_id: 'writer', id: 'team-b', name: 'Beta',
    nodes: [{ agent_id: 'writer', position: { x: 0, y: 0 } }],
  },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/teams']}>
      <Routes>
        <Route path="/teams" element={<TeamWorkspaceLayout />}>
          <Route index element={<TeamLibraryPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('TeamLibraryPage', () => {
  beforeEach(() => {
    useApiClient.mockReturnValue({ delete: vi.fn() })
    useTeamLibrary.mockReturnValue({ agents, error: null, loading: false, reload: vi.fn(), teams, tools: [] })
  })

  it('exits the old DAG before showing the newly selected Team', async () => {
    renderPage()
    expect(screen.getByTestId('team-canvas').textContent).toBe('Alpha')

    await userEvent.click(screen.getByRole('button', { name: /Beta/ }))
    expect(screen.getByTestId('team-canvas').textContent).toBe('Alpha')
    expect(screen.getByTestId('team-canvas').getAttribute('data-phase')).toBe('exiting')

    await userEvent.click(screen.getByRole('button', { name: 'Complete team scene' }))
    expect(screen.getByTestId('team-canvas').textContent).toBe('Beta')
    expect(screen.getByTestId('team-canvas').getAttribute('data-phase')).toBe('entering')

    await userEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(screen.getByTestId('team-canvas').textContent).toBe('Beta')

    await userEvent.click(screen.getByRole('button', { name: 'Complete team scene' }))
    expect(screen.getByTestId('team-canvas').getAttribute('data-phase')).toBe('idle')
  })

  it('opens the selected Team in its configure route', () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'Configure' }).getAttribute('href')).toBe('/teams/team-a')
  })

  it('renders the product empty state', () => {
    useTeamLibrary.mockReturnValue({ agents, error: null, loading: false, reload: vi.fn(), teams: [], tools: [] })
    renderPage()
    expect(screen.getByRole('heading', { name: 'Compose your first agent team' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Create team' }).getAttribute('href')).toBe('/teams/new')
  })
})
