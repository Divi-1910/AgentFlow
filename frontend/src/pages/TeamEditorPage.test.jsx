import { useState } from 'react'
import { Provider } from 'jotai'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useApiClient } from '../hooks/useApiClient'
import { useTeamEditorData } from '../hooks/useTeamEditorData'
import TeamEditorPage from './TeamEditorPage'

vi.mock('../hooks/useApiClient', () => ({ useApiClient: vi.fn() }))
vi.mock('../hooks/useTeamEditorData', () => ({ useTeamEditorData: vi.fn() }))
vi.mock('../components/teams/TeamAgentPalette', () => ({
  default: ({ onAddAgent, onCanvasInsetChange, onClose }) => (
    <div>
      <button type="button" onClick={() => onAddAgent('lead')}>Add Lead</button>
      <button type="button" onClick={() => onAddAgent('writer')}>Add Writer</button>
      <button type="button" onClick={() => onCanvasInsetChange('left', 356)}>Report palette inset</button>
      <button type="button" onClick={onClose}>Close Agent catalog</button>
    </div>
  ),
}))
vi.mock('../components/teams/TeamInspector', () => ({
  default: ({ draft, onCanvasInsetChange, onSetField }) => (
    <div>
      <label>
        Team name
        <input value={draft.name} onChange={(event) => onSetField('name', event.target.value)} />
      </label>
      <button type="button" onClick={() => onCanvasInsetChange('right', 392)}>Report inspector inset</button>
    </div>
  ),
}))

const agents = [
  { id: 'lead', name: 'Lead', tools: [] },
  { id: 'writer', name: 'Writer', tools: [] },
]

function EditorLayout() {
  const [presentation, setPresentation] = useState(null)
  return (
    <>
      <button type="button" onClick={presentation?.onOpenTeam}>Open Team settings</button>
      <button type="button" onClick={() => presentation?.onConnectAgents('lead', 'writer', 'bottom', 'top')}>Connect Lead to Writer</button>
      <button type="button" onClick={() => presentation?.onLayoutActivityChange(true)}>Start layout settlement</button>
      <button type="button" onClick={() => {
        presentation?.onPositionsSettled({ lead: { x: 480, y: 260 } })
        presentation?.onLayoutActivityChange(false)
      }}>Finish layout settlement</button>
      <output data-testid="canvas-insets">{JSON.stringify(presentation?.canvasInsets || null)}</output>
      <Outlet context={{ publishCanvasPresentation: setPresentation }} />
    </>
  )
}

function renderPage() {
  return render(
    <Provider>
      <MemoryRouter initialEntries={['/teams/new']}>
        <Routes>
          <Route path="/teams" element={<EditorLayout />}>
            <Route index element={<div>Team library destination</div>} />
            <Route path="new" element={<TeamEditorPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}

describe('TeamEditorPage', () => {
  const post = vi.fn()

  beforeEach(() => {
    post.mockReset()
    useApiClient.mockReturnValue({ patch: vi.fn(), post })
    useTeamEditorData.mockReturnValue({ agents, error: null, loading: false, reload: vi.fn(), team: null, tools: [] })
  })

  it('creates a Team from the composed graph and returns to the library', async () => {
    post.mockImplementation(async (_, payload) => ({ id: 'team-1', kind: 'agent_team', ...payload }))
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Add Lead' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open Team settings' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Team name' }), 'Research team')
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/agent-teams', expect.objectContaining({
      edges: [],
      entry_agent_id: 'lead',
      name: 'Research team',
      nodes: [{ agent_id: 'lead', position: { x: 120, y: 150 } }],
    })))
    expect(await screen.findByText('Team library destination')).toBeTruthy()
  })

  it('persists the exact canvas ports without reversing caller and callee', async () => {
    post.mockImplementation(async (_, payload) => ({ id: 'team-1', kind: 'agent_team', ...payload }))
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Add Lead' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add Writer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Connect Lead to Writer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open Team settings' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Team name' }), 'Research team')
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/agent-teams', expect.objectContaining({
      edges: [expect.objectContaining({
        source_agent_id: 'lead',
        source_port: 'bottom',
        target_agent_id: 'writer',
        target_port: 'top',
      })],
    })))
  })

  it('waits for visible layout settlement before creating the Team', async () => {
    post.mockImplementation(async (_, payload) => ({ id: 'team-1', kind: 'agent_team', ...payload }))
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Add Lead' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open Team settings' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Team name' }), 'Research team')
    await userEvent.click(screen.getByRole('button', { name: 'Start layout settlement' }))

    expect(screen.getByText('Aligning team layout…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create team' }).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Finish layout settlement' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create team' }).disabled).toBe(false))
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/agent-teams', expect.objectContaining({
      nodes: [{ agent_id: 'lead', position: { x: 480, y: 260 } }],
    })))
  })

  it('publishes the active panel safe area and clears it when the panel closes', async () => {
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Report palette inset' }))
    await waitFor(() => expect(JSON.parse(screen.getByTestId('canvas-insets').textContent)).toEqual({
      bottom: 0,
      left: 356,
      right: 0,
      top: 0,
    }))

    await userEvent.click(screen.getByRole('button', { name: 'Close Agent catalog' }))
    await waitFor(() => expect(JSON.parse(screen.getByTestId('canvas-insets').textContent)).toEqual({
      bottom: 0,
      left: 0,
      right: 0,
      top: 0,
    }))

    await userEvent.click(screen.getByRole('button', { name: 'Open Team settings' }))
    await userEvent.click(screen.getByRole('button', { name: 'Report inspector inset' }))
    await waitFor(() => expect(JSON.parse(screen.getByTestId('canvas-insets').textContent)).toEqual({
      bottom: 0,
      left: 0,
      right: 392,
      top: 0,
    }))
  })
})
