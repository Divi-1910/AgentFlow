import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import AgentWorkspaceLayout from './AgentWorkspaceLayout'

vi.mock('./AgentForgeCanvas', () => ({
  default: () => (
    <label>
      Canvas continuity marker
      <input aria-label="Canvas continuity marker" defaultValue="mounted" />
    </label>
  ),
}))

function LibraryRoute() {
  return <Link to="/agents/new?panel=agent&tab=overview">Open editor</Link>
}

function EditorRoute() {
  return <p>Editor controls</p>
}

describe('AgentWorkspaceLayout', () => {
  it('preserves the canvas instance while nested agent routes change', async () => {
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <Routes>
          <Route path="/agents" element={<AgentWorkspaceLayout />}>
            <Route index element={<LibraryRoute />} />
            <Route path="new" element={<EditorRoute />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    const user = userEvent.setup()
    const marker = screen.getByLabelText('Canvas continuity marker')
    await user.clear(marker)
    await user.type(marker, 'anchored')
    await user.click(screen.getByRole('link', { name: 'Open editor' }))

    expect(screen.getByText('Editor controls')).toBeTruthy()
    expect(screen.getByLabelText('Canvas continuity marker')).toBe(marker)
    expect(marker.value).toBe('anchored')
  })
})
