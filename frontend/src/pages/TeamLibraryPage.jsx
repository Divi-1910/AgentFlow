import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import useTeamCanvasPanelInset from '../components/teams/useTeamCanvasPanelInset'
import { describeTeamExecution, teamToDraft } from '../features/teams/teamGraph'
import { EMPTY_TEAM_CANVAS_INSETS } from '../features/teams/teamCanvasViewport'
import { useApiClient } from '../hooks/useApiClient'
import { useTeamLibrary } from '../hooks/useTeamLibrary'

const preloadTeamEditor = () => import('./TeamEditorPage')
const sceneDeadline = { entering: 450, exiting: 350 }

function TeamLibraryState({ error, onRetry }) {
  return (
    <section className="team-library-state" role={error ? 'alert' : undefined}>
      <span aria-hidden="true" className="material-symbols-outlined">account_tree</span>
      <p>Team workspace / 00</p>
      <h1>{error ? 'The team library could not be loaded' : 'Compose your first agent team'}</h1>
      <small>{error?.message || 'Connect reusable agents into a directed delegation graph.'}</small>
      {error ? (
        <button type="button" onClick={onRetry} className="agent-primary-button">Retry connection</button>
      ) : (
        <Link to="/teams/new" state={{ createPreview: true }} className="agent-primary-button" onMouseEnter={preloadTeamEditor}>
          <span aria-hidden="true" className="material-symbols-outlined">add</span>
          Create team
        </Link>
      )}
    </section>
  )
}

function TeamRow({ index, onSelect, selected, team }) {
  return (
    <button type="button" className={`team-library-row ${selected ? 'team-library-row--selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <span>{String(index + 1).padStart(2, '0')}</span>
      <span>
        <strong>{team.name}</strong>
        <small>{team.nodes?.length || 0} agents · {team.edges?.length || 0} delegations</small>
      </span>
      <i aria-hidden="true" className="material-symbols-outlined">arrow_outward</i>
    </button>
  )
}

export default function TeamLibraryPage() {
  const api = useApiClient()
  const location = useLocation()
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const { publishCanvasPresentation } = useOutletContext()
  const loaded = useTeamLibrary()
  const preview = location.state?.libraryPreview
  const hasPreview = Array.isArray(preview?.teams) && Array.isArray(preview?.agents) && Array.isArray(preview?.tools)
  const teams = loaded.loading && hasPreview ? preview.teams : loaded.teams
  const agents = loaded.loading && hasPreview ? preview.agents : loaded.agents
  const tools = loaded.loading && hasPreview ? preview.tools : loaded.tools
  const loading = loaded.loading && !hasPreview
  const [selectedId, setSelectedId] = useState(() => preview?.selectedId || null)
  const [pendingSelectedId, setPendingSelectedId] = useState(null)
  const [query, setQuery] = useState('')
  const [scenePhase, setScenePhase] = useState('idle')
  const [pendingNavigation, setPendingNavigation] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [panelInsetCache, setPanelInsetCache] = useState(EMPTY_TEAM_CANVAS_INSETS)
  const deferredQuery = useDeferredValue(query)
  const enteringFromEditor = location.state?.animateLibraryEntry === true
  const overlaysActive = !loading && !loaded.error && teams.length > 0
  const reportCanvasInset = useCallback((side, value) => {
    if (!Object.hasOwn(EMPTY_TEAM_CANVAS_INSETS, side)) return
    setPanelInsetCache((current) => current[side] === value ? current : { ...current, [side]: value })
  }, [])
  const teamIndexRef = useTeamCanvasPanelInset('right', reportCanvasInset, overlaysActive)
  const teamDockRef = useTeamCanvasPanelInset('bottom', reportCanvasInset, overlaysActive)

  useEffect(() => {
    if (teams.length === 0) return setSelectedId(null)
    if (!selectedId || !teams.some((team) => team.id === selectedId)) setSelectedId(teams[0].id)
  }, [selectedId, teams])

  const selectedTeam = teams.find((team) => team.id === selectedId) || teams[0]
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const filteredTeams = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    if (!normalized) return teams
    return teams.filter((team) => {
      const memberNames = (team.nodes || []).map((node) => agentsById.get(node.agent_id)?.name)
      return [team.name, team.description, ...memberNames]
        .some((value) => String(value || '').toLowerCase().includes(normalized))
    })
  }, [agentsById, deferredQuery, teams])
  const entryAgent = selectedTeam ? agentsById.get(selectedTeam.entry_agent_id) : null
  const selectedTeamDraft = useMemo(() => teamToDraft(selectedTeam), [selectedTeam])
  const execution = useMemo(() => describeTeamExecution(selectedTeamDraft, agents), [agents, selectedTeamDraft])
  const outboundPreview = useMemo(() => ({ agents, selectedId: selectedTeam?.id || null, teams, tools }), [agents, selectedTeam?.id, teams, tools])
  const editorState = useMemo(() => ({ libraryPreview: outboundPreview, teamPreview: selectedTeam }), [outboundPreview, selectedTeam])
  const createState = useMemo(() => ({ agentsPreview: agents, createPreview: true, libraryPreview: outboundPreview, toolsPreview: tools }), [agents, outboundPreview, tools])
  const selectionTransitioning = scenePhase !== 'idle'
  const canvasInsets = useMemo(() => !overlaysActive || pendingNavigation
    ? EMPTY_TEAM_CANVAS_INSETS
    : {
        ...EMPTY_TEAM_CANVAS_INSETS,
        bottom: panelInsetCache.bottom,
        right: panelInsetCache.right,
      }, [overlaysActive, panelInsetCache.bottom, panelInsetCache.right, pendingNavigation])

  const selectTeam = useCallback((teamId) => {
    if (pendingNavigation || selectionTransitioning || teamId === selectedTeam?.id) return
    setActionError(null)
    if (reduceMotion || (selectedTeam?.nodes?.length || 0) === 0) return setSelectedId(teamId)
    setPendingSelectedId(teamId)
    setScenePhase('exiting')
  }, [pendingNavigation, reduceMotion, selectedTeam?.id, selectedTeam?.nodes?.length, selectionTransitioning])

  const completeSceneTransition = useCallback((phase) => {
    if (phase === 'exiting' && scenePhase === 'exiting' && pendingSelectedId) {
      setSelectedId(pendingSelectedId)
      setScenePhase('entering')
    } else if (phase === 'entering' && scenePhase === 'entering') {
      setPendingSelectedId(null)
      setScenePhase('idle')
    }
  }, [pendingSelectedId, scenePhase])

  useEffect(() => {
    if (scenePhase === 'idle' || reduceMotion) return undefined
    const timer = window.setTimeout(() => completeSceneTransition(scenePhase), sceneDeadline[scenePhase])
    return () => window.clearTimeout(timer)
  }, [completeSceneTransition, reduceMotion, scenePhase])

  const beginNavigation = useCallback(async (to, state) => {
    if (pendingNavigation || selectionTransitioning) return
    const ready = preloadTeamEditor().catch(() => null)
    if (reduceMotion || (selectedTeam?.nodes?.length || 0) === 0) {
      await ready
      navigate(to, { state })
      return
    }
    setPendingNavigation({ state, to })
  }, [navigate, pendingNavigation, reduceMotion, selectedTeam?.nodes?.length, selectionTransitioning])

  const completeNavigation = useCallback(async () => {
    if (!pendingNavigation) return
    await preloadTeamEditor().catch(() => null)
    navigate(pendingNavigation.to, { state: pendingNavigation.state })
  }, [navigate, pendingNavigation])

  useEffect(() => {
    if (!pendingNavigation || reduceMotion) return undefined
    const timer = window.setTimeout(completeNavigation, 300)
    return () => window.clearTimeout(timer)
  }, [completeNavigation, pendingNavigation, reduceMotion])

  useLayoutEffect(() => {
    publishCanvasPresentation({
      agents,
      canvasInsets,
      draft: selectedTeamDraft,
      identity: selectedTeam?.id || 'team-library-empty',
      interactionDisabled: loading || Boolean(loaded.error) || !selectedTeam || selectionTransitioning || Boolean(pendingNavigation),
      mode: 'library',
      onSceneTransitionComplete: completeSceneTransition,
      onSelect: undefined,
      preserveViewport: false,
      scenePhase,
      selection: { id: null, type: 'team' },
    })
  }, [agents, canvasInsets, completeSceneTransition, loaded.error, loading, pendingNavigation, publishCanvasPresentation, scenePhase, selectedTeam, selectedTeamDraft, selectionTransitioning])

  async function deleteTeam() {
    if (!selectedTeam || !window.confirm(`Delete “${selectedTeam.name}”? This cannot be undone.`)) return
    setDeleting(true)
    setActionError(null)
    try {
      await api.delete(`/agent-teams/${selectedTeam.id}`)
      setSelectedId(null)
      loaded.reload()
    } catch (error) {
      const dependencies = error.data?.dependencies
      setActionError(Array.isArray(dependencies) && dependencies.length > 0
        ? `This team is still used by ${dependencies.join(', ')}.`
        : error.message || 'The team could not be deleted.')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <section className="team-library-loading animate-pulse" aria-label="Loading team library" />
  if (loaded.error) return <TeamLibraryState error={loaded.error} onRetry={loaded.reload} />
  if (teams.length === 0) return <TeamLibraryState />

  return (
    <>
      <motion.header className="team-library-header" initial={enteringFromEditor && !reduceMotion ? { opacity: 0, y: -12 } : false} animate={{ opacity: 1, y: 0 }}>
        <div>
          <p>Team workspace <span>/</span> Library</p>
          <h1>Agent Teams</h1>
          <small>{teams.length} orchestration {teams.length === 1 ? 'graph' : 'graphs'}</small>
        </div>
        <Link
          to="/teams/new"
          state={createState}
          className="agent-primary-button"
          onMouseEnter={preloadTeamEditor}
          onFocus={preloadTeamEditor}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            beginNavigation('/teams/new', createState)
          }}
        >
          <span aria-hidden="true" className="material-symbols-outlined">add</span>
          Create team
        </Link>
      </motion.header>

      <div className="team-library-overlays" data-exiting={Boolean(pendingNavigation)}>
        <motion.aside
          className="team-library-index"
          ref={teamIndexRef}
          initial={enteringFromEditor && !reduceMotion ? { opacity: 0, x: 'calc(100% + 2rem)' } : false}
          animate={pendingNavigation ? { opacity: 0, x: 'calc(100% + 2rem)' } : { opacity: 1, x: 0 }}
        >
          <div className="team-panel-heading"><span>Team index</span><strong>{String(filteredTeams.length).padStart(2, '0')}</strong></div>
          <label htmlFor="team-search" className="sr-only">Search teams</label>
          <div className="team-library-search">
            <span aria-hidden="true" className="material-symbols-outlined">search</span>
            <input id="team-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search teams" />
          </div>
          <div className="team-library-index__list">
            {filteredTeams.map((team) => (
              <TeamRow key={team.id} team={team} index={teams.indexOf(team)} selected={(pendingSelectedId || selectedTeam.id) === team.id} onSelect={() => selectTeam(team.id)} />
            ))}
            {filteredTeams.length === 0 ? <p className="team-library-index__empty">No teams match “{deferredQuery}”.</p> : null}
          </div>
        </motion.aside>

        <motion.div
          className="team-library-dock"
          ref={teamDockRef}
          initial={enteringFromEditor && !reduceMotion ? { opacity: 0, y: 'calc(100% + 2rem)' } : false}
          animate={pendingNavigation ? { opacity: 0, y: 'calc(100% + 2rem)' } : { opacity: 1, y: 0 }}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.div key={selectedTeam.id} className="team-library-dock__copy" initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -7 }}>
              <span>Selected team</span>
              <strong>{selectedTeam.name}</strong>
              <p>{selectedTeam.description || 'No description has been added for this team.'}</p>
              <small>Entry · {entryAgent?.name || 'Unavailable agent'} · {selectedTeam.nodes.length} agents · {selectedTeam.edges.length} delegations</small>
              <small className="team-library-dock__runtime">{execution.intro} {execution.note}</small>
            </motion.div>
          </AnimatePresence>
          <div className="team-library-dock__actions">
            <Link to={`/chat?resource_kind=agent_team&resource_id=${encodeURIComponent(selectedTeam.id)}`} className="agent-secondary-button"><span aria-hidden="true" className="material-symbols-outlined">forum</span>Open chat</Link>
            <Link
              to={`/teams/${selectedTeam.id}`}
              state={editorState}
              className="agent-secondary-button"
              onMouseEnter={preloadTeamEditor}
              onFocus={preloadTeamEditor}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                beginNavigation(`/teams/${selectedTeam.id}`, editorState)
              }}
            >
              <span aria-hidden="true" className="material-symbols-outlined">tune</span>Configure
            </Link>
            <button type="button" className="agent-danger-button" disabled={deleting} onClick={deleteTeam}>
              <span aria-hidden="true" className="material-symbols-outlined">delete</span>{deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </motion.div>
      </div>
      {actionError ? <div className="team-library-error" role="alert">{actionError}<button type="button" onClick={() => setActionError(null)}>Dismiss</button></div> : null}
    </>
  )
}
