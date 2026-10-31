import { Suspense, useCallback, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { createEmptyAgentForm } from '../../features/agents/agentForm'
import AgentForgeCanvas from './AgentForgeCanvas'

const initialPresentation = {
  dirty: false,
  form: createEmptyAgentForm(),
  identity: 'agent-workspace',
  inspectorOpen: false,
  interactionDisabled: true,
  mcpChoices: [],
  mode: 'library',
  onOpenInspector: undefined,
  onSceneTransitionComplete: undefined,
  panelPlacement: 'library',
  preserveViewport: false,
  scenePhase: 'idle',
  toolChoices: [],
}

export default function AgentWorkspaceLayout() {
  const { pathname } = useLocation()
  const [presentation, setPresentation] = useState(initialPresentation)
  const publishCanvasPresentation = useCallback((nextPresentation) => {
    setPresentation(nextPresentation)
  }, [])
  const outletContext = useMemo(
    () => ({ publishCanvasPresentation }),
    [publishCanvasPresentation],
  )
  const libraryMode = pathname === '/agents' || pathname === '/agents/'

  return (
    <section className={`agent-workspace-page ${libraryMode ? 'agent-library-page' : 'agent-forge-page'}`}>
      <AgentForgeCanvas {...presentation} />

      <Suspense fallback={null}>
        <Outlet context={outletContext} />
      </Suspense>
    </section>
  )
}
