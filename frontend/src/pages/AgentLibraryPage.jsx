import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { agentToForm } from '../features/agents/agentForm'
import { useApiClient } from '../hooks/useApiClient'
import { useAgentLibrary } from '../hooks/useAgentLibrary'

const preloadAgentEditor = () => import('./AgentEditorPage')
const agentEditorPath = (agentId) => `/agents/${agentId}?panel=agent&tab=overview`
const createAgentPath = '/agents/new?panel=agent&tab=overview'
const sceneCompletionDeadline = {
  entering: 450,
  exiting: 350,
}

function formatUpdatedAt(value) {
  if (!value) return 'No update recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Update time unavailable'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function dependencyLabel(value) {
  return {
    agent_team_membership: 'agent team membership',
    deployment_state: 'deployment state',
    publications: 'published revisions',
    threads: 'conversations',
  }[value] || value.replaceAll('_', ' ')
}

function AgentLibraryLoading() {
  return (
    <section aria-label="Loading agent library" className="agent-library-page agent-library-page--loading animate-pulse">
      <div className="agent-library-loading__header" />
      <div className="agent-library-loading__core" />
      <div className="agent-library-loading__rail" />
      <div className="agent-library-loading__dock" />
    </section>
  )
}

function AgentLibraryError({ error, onRetry }) {
  return (
    <section className="agent-library-page agent-library-page--state" role="alert">
      <div className="max-w-md text-center">
        <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.24em] text-red-300/70">Connection problem</p>
        <h1 className="mt-4 font-headline text-3xl font-semibold text-white">The agent library could not be loaded</h1>
        <p className="mt-4 text-sm leading-6 text-white/50">{error?.message || 'AgentFlow could not load your agents.'}</p>
        <button type="button" onClick={onRetry} className="agent-primary-button mt-7">Retry connection</button>
      </div>
    </section>
  )
}

function EmptyLibrary({ createState, onCreate }) {
  return (
    <section className="agent-library-page agent-library-page--state">
      <div className="agent-library-empty">
        <span className="agent-library-empty__icon">
          <span aria-hidden="true" className="material-symbols-outlined">neurology</span>
        </span>
        <p>Agent Library / 00</p>
        <h1>Build your first intelligence</h1>
        <span>Choose a model, connect its tools, and give the agent a clear operating purpose.</span>
        <Link
          to={createAgentPath}
          state={createState}
          className="agent-primary-button mt-7 inline-flex"
          onClick={onCreate}
          onMouseEnter={preloadAgentEditor}
          onFocus={preloadAgentEditor}
        >
          <span aria-hidden="true" className="material-symbols-outlined">add</span>
          Create agent
        </Link>
      </div>
    </section>
  )
}

function AgentRow({ agent, selected, onSelect }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Select ${agent.name}`}
      onClick={onSelect}
      className={`agent-library-row ${selected ? 'agent-library-row--selected' : ''}`}
    >
      <span className="agent-library-row__index" aria-hidden="true">
        {String(agent.libraryIndex).padStart(2, '0')}
      </span>
      <span className="agent-library-row__copy">
        <strong>{agent.name}</strong>
        <span>{agent.provider} · {agent.model}</span>
      </span>
      <span aria-hidden="true" className="material-symbols-outlined agent-library-row__arrow">arrow_outward</span>
    </button>
  )
}

export default function AgentLibraryPage() {
  const api = useApiClient()
  const location = useLocation()
  const navigate = useNavigate()
  const { publishCanvasPresentation } = useOutletContext()
  const reduceMotion = useReducedMotion()
  const {
    agents: loadedAgents,
    error,
    loading: libraryLoading,
    mcpServers: loadedMcpServers,
    reload,
    tools: loadedTools,
  } = useAgentLibrary()
  const routeLibraryPreview = location.state?.libraryPreview
  const hasLibraryPreview = Array.isArray(routeLibraryPreview?.agents)
    && Array.isArray(routeLibraryPreview?.mcpServers)
    && Array.isArray(routeLibraryPreview?.tools)
  const agents = libraryLoading && hasLibraryPreview ? routeLibraryPreview.agents : loadedAgents
  const mcpServers = libraryLoading && hasLibraryPreview ? routeLibraryPreview.mcpServers : loadedMcpServers
  const tools = libraryLoading && hasLibraryPreview ? routeLibraryPreview.tools : loadedTools
  const loading = libraryLoading && !hasLibraryPreview
  const [selectedId, setSelectedId] = useState(() => routeLibraryPreview?.selectedId || null)
  const [query, setQuery] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [pendingNavigation, setPendingNavigation] = useState(null)
  const [pendingSelectedId, setPendingSelectedId] = useState(null)
  const [scenePhase, setScenePhase] = useState('idle')
  const deferredQuery = useDeferredValue(query)
  const enteringFromEditor = location.state?.animateLibraryEntry === true
  const selectionTransitioning = scenePhase !== 'idle'

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !agents.some((agent) => agent.id === selectedId)) {
      setSelectedId(agents[0].id)
    }
  }, [agents, selectedId])

  const indexedAgents = useMemo(
    () => agents.map((agent, index) => ({ ...agent, libraryIndex: index + 1 })),
    [agents],
  )
  const filteredAgents = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()
    if (!normalizedQuery) return indexedAgents
    return indexedAgents.filter((agent) => (
      [agent.name, agent.provider, agent.model]
        .some((value) => String(value || '').toLowerCase().includes(normalizedQuery))
    ))
  }, [deferredQuery, indexedAgents])

  const selectedAgent = indexedAgents.find((agent) => agent.id === selectedId) || indexedAgents[0]
  const selectedRowId = pendingSelectedId || selectedAgent?.id
  const selectedForm = useMemo(() => agentToForm(selectedAgent), [selectedAgent])
  const outboundLibraryPreview = useMemo(() => ({
    agents,
    mcpServers,
    selectedId: selectedAgent?.id || null,
    tools,
  }), [agents, mcpServers, selectedAgent?.id, tools])
  const editorState = useMemo(() => ({
    agentPreview: selectedAgent,
    libraryPreview: outboundLibraryPreview,
    mcpServersPreview: mcpServers,
    toolsPreview: tools,
  }), [mcpServers, outboundLibraryPreview, selectedAgent, tools])
  const createEditorState = useMemo(() => ({
    createPreview: true,
    libraryPreview: outboundLibraryPreview,
    mcpServersPreview: mcpServers,
    toolsPreview: tools,
  }), [mcpServers, outboundLibraryPreview, tools])

  const beginCanvasNavigation = useCallback(async (to, state = null) => {
    if (pendingNavigation || selectionTransitioning) return

    const editorReady = preloadAgentEditor().catch(() => null)

    if (reduceMotion) {
      await editorReady
      navigate(to, { state })
      return
    }
    setPendingNavigation({ state, to })
  }, [navigate, pendingNavigation, reduceMotion, selectionTransitioning])

  const beginLinkNavigation = useCallback((event, to, state = null) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    beginCanvasNavigation(to, state)
  }, [beginCanvasNavigation])

  const completeCanvasNavigation = useCallback(async (animationState) => {
    if (animationState === 'visible' && enteringFromEditor && !pendingNavigation) {
      navigate('/agents', {
        replace: true,
        state: hasLibraryPreview ? { libraryPreview: routeLibraryPreview } : null,
      })
      return
    }
    if (animationState !== 'exiting' || !pendingNavigation) return

    const target = pendingNavigation

    await preloadAgentEditor().catch(() => null)
    navigate(target.to, { state: target.state })
  }, [enteringFromEditor, hasLibraryPreview, navigate, pendingNavigation, routeLibraryPreview])

  const openEmptyCreate = useCallback(async (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    event.preventDefault()
    await preloadAgentEditor().catch(() => null)
    navigate(createAgentPath, { state: createEditorState })
  }, [createEditorState, navigate])

  const openSelectedAgent = useCallback(() => {
    if (!selectedAgent || selectionTransitioning) return
    beginCanvasNavigation(agentEditorPath(selectedAgent.id), editorState)
  }, [beginCanvasNavigation, editorState, selectedAgent, selectionTransitioning])

  const selectAgent = useCallback((agentId) => {
    if (selectionTransitioning || agentId === selectedAgent?.id) return

    setActionError(null)
    if (reduceMotion) {
      setSelectedId(agentId)
      return
    }
    setPendingSelectedId(agentId)
    setScenePhase('exiting')
  }, [reduceMotion, selectedAgent?.id, selectionTransitioning])

  const completeSceneTransition = useCallback((completedPhase) => {
    if (completedPhase === 'exiting' && scenePhase === 'exiting' && pendingSelectedId) {
      setSelectedId(pendingSelectedId)
      setScenePhase('entering')
      return
    }
    if (completedPhase === 'entering' && scenePhase === 'entering') {
      setPendingSelectedId(null)
      setScenePhase('idle')
    }
  }, [pendingSelectedId, scenePhase])

  useEffect(() => {
    if (scenePhase === 'idle' || reduceMotion) return undefined

    const timer = window.setTimeout(() => {
      completeSceneTransition(scenePhase)
    }, sceneCompletionDeadline[scenePhase])

    return () => window.clearTimeout(timer)
  }, [completeSceneTransition, reduceMotion, scenePhase])

  useLayoutEffect(() => {
    publishCanvasPresentation({
      dirty: false,
      form: selectedForm,
      identity: selectedAgent?.id || 'agent-library-empty',
      inspectorOpen: false,
      interactionDisabled: loading || Boolean(error) || !selectedAgent || selectionTransitioning,
      mcpChoices: mcpServers,
      mode: 'library',
      onOpenInspector: selectedAgent ? openSelectedAgent : undefined,
      onSceneTransitionComplete: completeSceneTransition,
      panelPlacement: 'library',
      preserveViewport: false,
      scenePhase,
      toolChoices: tools,
    })
  }, [
    error,
    loading,
    mcpServers,
    completeSceneTransition,
    openSelectedAgent,
    publishCanvasPresentation,
    selectedAgent,
    selectedForm,
    scenePhase,
    selectionTransitioning,
    tools,
  ])

  async function deleteSelectedAgent() {
    if (!selectedAgent) return
    const confirmed = window.confirm(`Delete “${selectedAgent.name}”? This cannot be undone.`)
    if (!confirmed) return

    setActionError(null)
    setDeletingId(selectedAgent.id)
    try {
      await api.delete(`/agents/${selectedAgent.id}`)
      setSelectedId(null)
      reload()
    } catch (deleteError) {
      const dependencies = deleteError.data?.dependencies
      if (Array.isArray(dependencies) && dependencies.length > 0) {
        setActionError(`This agent cannot be deleted because it is still used by ${dependencies.map(dependencyLabel).join(', ')}.`)
      } else {
        setActionError(deleteError.message || 'The agent could not be deleted.')
      }
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) return <AgentLibraryLoading />
  if (error) return <AgentLibraryError error={error} onRetry={reload} />
  if (agents.length === 0) {
    return (
      <EmptyLibrary
        createState={createEditorState}
        onCreate={openEmptyCreate}
      />
    )
  }

  return (
    <>
      <motion.header
        className="agent-library-header"
        initial={enteringFromEditor && !reduceMotion ? { opacity: 0, y: -12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <div>
          <p>Agent workspace <span>/</span> Library</p>
          <h1>Agent Library</h1>
          <small>{agents.length} {agents.length === 1 ? 'intelligence' : 'intelligences'} online</small>
        </div>
        <Link
          to={createAgentPath}
          state={createEditorState}
          className="agent-primary-button inline-flex"
          onMouseEnter={preloadAgentEditor}
          onFocus={preloadAgentEditor}
          onClick={(event) => beginLinkNavigation(event, createAgentPath, createEditorState)}
          aria-disabled={Boolean(pendingNavigation) || selectionTransitioning}
        >
          <span aria-hidden="true" className="material-symbols-outlined">add</span>
          Create agent
        </Link>
      </motion.header>

      <div
        className="agent-library-overlay-layer"
        data-exiting={pendingNavigation ? 'true' : 'false'}
      >
          <motion.aside
            className="agent-library-index"
            aria-label="Agent index"
            initial={enteringFromEditor && !reduceMotion ? 'entering' : false}
            animate={pendingNavigation ? 'exiting' : 'visible'}
            variants={{
              visible: { opacity: 1, x: 0 },
              entering: { opacity: 0, x: 'calc(100% + 2rem)' },
              exiting: { opacity: 0, x: 'calc(100% + 2rem)' },
            }}
            transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="agent-library-index__heading">
              <span>Intelligence index</span>
              <strong>{String(filteredAgents.length).padStart(2, '0')}</strong>
            </div>
            <label htmlFor="agent-search" className="sr-only">Search agents</label>
            <div className="agent-library-search">
              <span aria-hidden="true" className="material-symbols-outlined">search</span>
              <input
                id="agent-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search intelligence"
              />
            </div>
            <div className="agent-library-index__list">
              {filteredAgents.length > 0 ? filteredAgents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedRowId}
                  onSelect={() => selectAgent(agent.id)}
                />
              )) : (
                <p className="agent-library-index__empty">No intelligence matches “{deferredQuery}”.</p>
              )}
            </div>
          </motion.aside>

          <motion.div
            className="agent-library-dock"
            initial={enteringFromEditor && !reduceMotion ? 'entering' : false}
            animate={pendingNavigation ? 'exiting' : 'visible'}
            variants={{
              visible: { opacity: 1, y: 0 },
              entering: { opacity: 0, y: 'calc(100% + 2rem)' },
              exiting: { opacity: 0, y: 'calc(100% + 2rem)' },
            }}
            transition={{ duration: 0.27, ease: [0.4, 0, 0.2, 1] }}
            onAnimationComplete={completeCanvasNavigation}
          >
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={selectedAgent.id}
                className="agent-library-dock__copy"
                initial={reduceMotion ? false : { opacity: 0, y: 8, filter: 'blur(5px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -6, filter: 'blur(5px)' }}
                transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <span>Selected intelligence</span>
                <strong>{selectedAgent.name}</strong>
                <p>{selectedAgent.description || 'No description has been added for this agent.'}</p>
                <small>Updated {formatUpdatedAt(selectedAgent.updated_at)}</small>
              </motion.div>
            </AnimatePresence>

            <div className="agent-library-dock__actions">
              <Link to={`/chat?resource_kind=standalone_agent&resource_id=${encodeURIComponent(selectedAgent.id)}`} className="agent-secondary-button inline-flex">
                <span aria-hidden="true" className="material-symbols-outlined">forum</span>
                Open chat
              </Link>
              <Link to={`/deployments?resource_kind=standalone_agent&resource_id=${encodeURIComponent(selectedAgent.id)}`} className="agent-secondary-button inline-flex">
                <span aria-hidden="true" className="material-symbols-outlined">deployed_code</span>
                Publish
              </Link>
              <Link
                to={agentEditorPath(selectedAgent.id)}
                state={editorState}
                className="agent-secondary-button inline-flex"
                onMouseEnter={preloadAgentEditor}
                onFocus={preloadAgentEditor}
                onClick={(event) => beginLinkNavigation(event, agentEditorPath(selectedAgent.id), editorState)}
                aria-disabled={Boolean(pendingNavigation) || selectionTransitioning}
              >
                <span aria-hidden="true" className="material-symbols-outlined">tune</span>
                Configure
              </Link>
              <button
                type="button"
                onClick={deleteSelectedAgent}
                disabled={deletingId === selectedAgent.id || Boolean(pendingNavigation) || selectionTransitioning}
                className="agent-danger-button"
              >
                <span aria-hidden="true" className="material-symbols-outlined">delete</span>
                {deletingId === selectedAgent.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </motion.div>
      </div>

      {actionError ? (
        <motion.div
          className="agent-library-action-error"
          role="alert"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss deletion error">
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </motion.div>
      ) : null}
    </>
  )
}
