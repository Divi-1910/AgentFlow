import { createStore, Provider, useAtomValue } from 'jotai'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { tokenAtom } from '../../store/atoms/authAtoms'
import TeamWorkspaceLayout from './TeamWorkspaceLayout'

vi.mock('./TeamGraphCanvas', () => ({
  default: () => <div data-testid="team-graph-canvas" />,
}))

function AuthenticationProbe() {
  const token = useAtomValue(tokenAtom)
  return <span data-testid="workspace-token">{token}</span>
}

describe('TeamWorkspaceLayout', () => {
  it('uses the application store instead of shadowing authentication state', () => {
    const store = createStore()
    store.set(tokenAtom, 'current-session-token')

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/teams']}>
          <Routes>
            <Route path="/teams" element={<TeamWorkspaceLayout />}>
              <Route index element={<AuthenticationProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </Provider>,
    )

    expect(screen.getByTestId('workspace-token').textContent).toBe('current-session-token')
    expect(screen.getByTestId('team-graph-canvas')).toBeTruthy()
  })
})
