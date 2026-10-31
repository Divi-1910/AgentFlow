import { Suspense, useCallback, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { createEmptyTeamDraft } from '../../features/teams/teamGraph'
import TeamGraphCanvas from './TeamGraphCanvas'

const initialPresentation = {
  agents: [],
  draft: createEmptyTeamDraft(),
  identity: 'team-workspace',
  interactionDisabled: true,
  mode: 'library',
  selection: { id: null, type: 'team' },
}

export default function TeamWorkspaceLayout() {
  const { pathname } = useLocation()
  const [presentation, setPresentation] = useState(initialPresentation)
  const publishCanvasPresentation = useCallback((nextPresentation) => setPresentation(nextPresentation), [])
  const outletContext = useMemo(() => ({ publishCanvasPresentation }), [publishCanvasPresentation])
  const libraryMode = pathname === '/teams' || pathname === '/teams/'

  return (
    <section className={`team-workspace-page ${libraryMode ? 'team-library-page' : 'team-forge-page'}`}>
      <TeamGraphCanvas {...presentation} />
      <Suspense fallback={null}>
        <Outlet context={outletContext} />
      </Suspense>
    </section>
  )
}
