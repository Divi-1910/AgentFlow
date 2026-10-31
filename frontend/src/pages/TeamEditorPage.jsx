import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useAtom, useAtomValue } from 'jotai'
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import TeamAgentPalette from '../components/teams/TeamAgentPalette'
import TeamInspector from '../components/teams/TeamInspector'
import {
  buildTeamCreatePayload,
  buildTeamPatch,
  defaultNodePosition,
  delegationId,
  getTeamConnectionError,
  normalizeTeamPort,
  suggestedDelegationName,
  teamToDraft,
  validateTeamDraft,
} from '../features/teams/teamGraph'
import { EMPTY_TEAM_CANVAS_INSETS } from '../features/teams/teamCanvasViewport'
import { useApiClient } from '../hooks/useApiClient'
import { useTeamEditorData } from '../hooks/useTeamEditorData'
import {
  teamBaselineAtom,
  teamDirtyAtom,
  teamDraftAtom,
  teamSelectionAtom,
} from '../store/atoms/teamAtoms'

function mergeTeamIntoPreview(preview, savedTeam, agents, tools) {
  const current = preview && Array.isArray(preview.teams)
    ? preview
    : { agents, selectedId: null, teams: [], tools }
  const exists = current.teams.some((team) => team.id === savedTeam.id)
  return {
    ...current,
    agents,
    selectedId: savedTeam.id,
    teams: exists
      ? current.teams.map((team) => (team.id === savedTeam.id ? savedTeam : team))
      : [...current.teams, savedTeam],
    tools,
  }
}

function EditorState({ error, onRetry }) {
  return (
    <section className="team-editor-state" role={error ? 'alert' : 'status'}>
      <span aria-hidden="true" className="material-symbols-outlined">account_tree</span>
      <h1>{error ? 'Team Forge is unavailable' : 'Loading Team Forge'}</h1>
      <p>{error?.message || 'Preparing agents and graph constraints…'}</p>
      {error ? <button type="button" onClick={onRetry} className="agent-primary-button">Retry connection</button> : null}
    </section>
  )
}

export default function TeamEditorPage() {
  const { teamId } = useParams()
  const isCreate = !teamId
  const location = useLocation()
  const navigate = useNavigate()
  const api = useApiClient()
  const { publishCanvasPresentation } = useOutletContext()
  const loaded = useTeamEditorData(teamId)
  const routeTeamPreview = !isCreate && location.state?.teamPreview?.id === teamId ? location.state.teamPreview : null
  const routeCreatePreview = isCreate && location.state?.createPreview === true
  const hasPreview = Boolean(routeTeamPreview || routeCreatePreview)
  const agents = loaded.loading && hasPreview && Array.isArray(location.state?.agentsPreview || location.state?.libraryPreview?.agents)
    ? (location.state.agentsPreview || location.state.libraryPreview.agents)
    : loaded.agents
  const tools = loaded.loading && hasPreview && Array.isArray(location.state?.toolsPreview || location.state?.libraryPreview?.tools)
    ? (location.state.toolsPreview || location.state.libraryPreview.tools)
    : loaded.tools
  const visibleTeam = routeTeamPreview || loaded.team
  const [draft, setDraft] = useAtom(teamDraftAtom)
  const [baseline, setBaseline] = useAtom(teamBaselineAtom)
  const [selection, setSelection] = useAtom(teamSelectionAtom)
  const dirty = useAtomValue(teamDirtyAtom)
  const [initializedFor, setInitializedFor] = useState(null)
  const [returning, setReturning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [layoutSettling, setLayoutSettling] = useState(false)
  const [notice, setNotice] = useState(null)
  const [backendError, setBackendError] = useState(null)
  const [interactionError, setInteractionError] = useState(null)
  const [surface, setSurface] = useState(null)
  const [panelInsetCache, setPanelInsetCache] = useState(EMPTY_TEAM_CANVAS_INSETS)
  const previewRef = useRef(location.state?.libraryPreview)
  const identity = teamId || 'new'
  const validation = useMemo(() => validateTeamDraft(draft, { agents, tools }), [agents, draft, tools])
  const editorLocked = (loaded.loading && !hasPreview) || (!isCreate && initializedFor !== identity)
  const reportCanvasInset = useCallback((side, value) => {
    if (!Object.hasOwn(EMPTY_TEAM_CANVAS_INSETS, side)) return
    setPanelInsetCache((current) => current[side] === value ? current : { ...current, [side]: value })
  }, [])
  const canvasInsets = useMemo(() => {
    if (returning || !surface) return EMPTY_TEAM_CANVAS_INSETS
    if (surface === 'catalog') return { ...EMPTY_TEAM_CANVAS_INSETS, left: panelInsetCache.left }
    return { ...EMPTY_TEAM_CANVAS_INSETS, right: panelInsetCache.right }
  }, [panelInsetCache.left, panelInsetCache.right, returning, surface])

  useEffect(() => {
    if (initializedFor === identity) return
    if (loaded.loading && !hasPreview) return
    const initialDraft = teamToDraft(visibleTeam)
    setDraft(initialDraft)
    setBaseline(initialDraft)
    setSelection({ id: null, type: 'team' })
    setSurface(isCreate ? 'catalog' : null)
    setInitializedFor(identity)
  }, [hasPreview, identity, initializedFor, isCreate, loaded.loading, setBaseline, setDraft, setSelection, visibleTeam])

  useEffect(() => {
    if (!dirty) return undefined
    const beforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  const updateDraft = useCallback((updater) => {
    setDraft(updater)
    setNotice(null)
    setBackendError(null)
    setInteractionError(null)
  }, [setDraft])

  const addAgent = useCallback((agentId, position) => {
    updateDraft((current) => {
      if (current.nodes.some((node) => node.agent_id === agentId) || current.nodes.length >= 50) return current
      const nodePosition = position || defaultNodePosition(current.nodes.length)
      return {
        ...current,
        entry_agent_id: current.entry_agent_id || agentId,
        nodes: [...current.nodes, { agent_id: agentId, position: nodePosition }],
      }
    })
    setSelection({ id: agentId, type: 'node' })
  }, [setSelection, updateDraft])

  const selectGraphElement = useCallback((nextSelection) => {
    setSelection(nextSelection)
    setSurface(nextSelection.type === 'team' ? null : 'selection')
  }, [setSelection])

  const settleAgentPositions = useCallback((positions) => {
    // Layout settlement is an internal canvas write, not a new user command.
    // Preserve any interaction or persistence error currently being shown.
    setDraft((current) => {
      let changed = false
      const nodes = current.nodes.map((node) => {
        const position = positions[node.agent_id]
        if (!position) return node
        if (Math.abs(node.position.x - position.x) < 0.01 && Math.abs(node.position.y - position.y) < 0.01) return node
        changed = true
        return { ...node, position }
      })
      return changed ? { ...current, nodes } : current
    })
  }, [setDraft])

  const connectAgents = useCallback((sourceAgentId, targetAgentId, sourcePort = 'right', targetPort = 'left') => {
    const connectionError = getTeamConnectionError(draft, sourceAgentId, targetAgentId)
    if (connectionError) {
      setInteractionError(connectionError)
      return false
    }
    let createdId = null
    updateDraft((current) => {
      if (current.edges.some((edge) => edge.source_agent_id === sourceAgentId && edge.target_agent_id === targetAgentId)) return current
      const targetAgent = agents.find((agent) => agent.id === targetAgentId)
      const sourceAgent = agents.find((agent) => agent.id === sourceAgentId)
      const occupiedNames = [
        ...(sourceAgent?.tools || []),
        ...tools.map((tool) => tool.name),
        ...current.edges.filter((edge) => edge.source_agent_id === sourceAgentId).map((edge) => edge.tool_name),
      ]
      const edge = {
        description: `Delegate work to ${targetAgent?.name || 'this agent'}.`,
        instructions: '',
        source_agent_id: sourceAgentId,
        source_port: normalizeTeamPort(sourcePort, 'right'),
        target_agent_id: targetAgentId,
        target_port: normalizeTeamPort(targetPort, 'left'),
        tool_name: suggestedDelegationName(targetAgent, occupiedNames),
      }
      createdId = delegationId(sourceAgentId, targetAgentId)
      return { ...current, edges: [...current.edges, edge] }
    })
    if (createdId) {
      setSelection({ id: createdId, type: 'edge' })
      setSurface('selection')
    }
    return Boolean(createdId)
  }, [agents, draft, setSelection, tools, updateDraft])

  const removeNode = useCallback((agentId) => {
    updateDraft((current) => {
      const nodes = current.nodes.filter((node) => node.agent_id !== agentId)
      return {
        ...current,
        edges: current.edges.filter((edge) => edge.source_agent_id !== agentId && edge.target_agent_id !== agentId),
        entry_agent_id: current.entry_agent_id === agentId ? (nodes[0]?.agent_id || '') : current.entry_agent_id,
        nodes,
      }
    })
    setSelection({ id: null, type: 'team' })
    setSurface(null)
  }, [setSelection, updateDraft])

  const removeEdge = useCallback((edgeId) => {
    updateDraft((current) => ({
      ...current,
      edges: current.edges.filter((edge) => delegationId(edge.source_agent_id, edge.target_agent_id) !== edgeId),
    }))
    setSelection({ id: null, type: 'team' })
    setSurface(null)
  }, [setSelection, updateDraft])

  const updateEdge = useCallback((edgeId, field, value) => {
    updateDraft((current) => ({
      ...current,
      edges: current.edges.map((edge) => (
        delegationId(edge.source_agent_id, edge.target_agent_id) === edgeId ? { ...edge, [field]: value } : edge
      )),
    }))
  }, [updateDraft])

  const openAgent = useCallback((agentId) => {
    if (dirty && !window.confirm('Leave Team Forge with unsaved changes?')) return
    navigate(`/agents/${agentId}?panel=agent&tab=overview`)
  }, [dirty, navigate])

  const leaveEditor = useCallback(() => {
    if (returning) return
    if (dirty && !window.confirm('Discard the unsaved changes to this team?')) return
    setReturning(true)
  }, [dirty, returning])

  useEffect(() => {
    if (!returning) return undefined
    const timer = window.setTimeout(() => {
      navigate('/teams', {
        state: { animateLibraryEntry: true, libraryPreview: previewRef.current },
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [navigate, returning])

  useLayoutEffect(() => {
    publishCanvasPresentation({
      agents,
      canvasInsets,
      draft,
      identity,
      interactionDisabled: editorLocked || returning,
      layoutPersistenceEnabled: initializedFor === identity && !editorLocked && !returning,
      mode: returning ? 'library' : 'editor',
      onAddAgent: addAgent,
      onConnectionRejected: setInteractionError,
      onConnectAgents: connectAgents,
      onOpenCatalog: () => setSurface('catalog'),
      onOpenReview: () => setSurface('review'),
      onOpenTeam: () => setSurface('team'),
      onLayoutActivityChange: setLayoutSettling,
      onPositionsSettled: settleAgentPositions,
      onSelect: selectGraphElement,
      preserveViewport: hasPreview,
      scenePhase: 'idle',
      selection,
    })
  }, [addAgent, agents, canvasInsets, connectAgents, draft, editorLocked, hasPreview, identity, initializedFor, publishCanvasPresentation, returning, selectGraphElement, selection, settleAgentPositions])

  async function saveTeam(event) {
    event.preventDefault()
    // React Flow owns the visible coordinates while magnetism is moving. Wait
    // until the canvas has committed them to the draft used by the API payload.
    if (editorLocked || returning || layoutSettling) return
    setBackendError(null)
    if (!validation.valid) {
      setSelection({ id: null, type: 'team' })
      setSurface('team')
      return
    }
    const patch = isCreate ? null : buildTeamPatch(draft, baseline)
    if (!isCreate && Object.keys(patch).length === 0) return

    setSaving(true)
    try {
      const saved = isCreate
        ? await api.post('/agent-teams', buildTeamCreatePayload(draft))
        : await api.patch(`/agent-teams/${teamId}`, patch)
      const savedDraft = teamToDraft(saved)
      setDraft(savedDraft)
      setBaseline(savedDraft)
      setNotice(isCreate ? 'Team created.' : 'Changes saved.')
      previewRef.current = mergeTeamIntoPreview(previewRef.current, saved, agents, tools)
      if (isCreate) setReturning(true)
    } catch (error) {
      setBackendError(error.message || 'The team could not be saved.')
      setSelection({ id: null, type: 'team' })
    } finally {
      setSaving(false)
    }
  }

  if (loaded.loading && !hasPreview) return <EditorState />
  if (loaded.error) return <EditorState error={loaded.error} onRetry={loaded.reload} />

  return (
    <form className="team-forge-overlay" onSubmit={saveTeam} noValidate>
      <header className="team-forge-header">
        <div className="team-forge-header__identity">
          <button type="button" className="agent-icon-button" onClick={leaveEditor} disabled={returning} aria-label="Back to team library">
            <span aria-hidden="true" className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <p>Team Forge <span>/</span> {isCreate ? 'New orchestration' : 'Edit orchestration'}</p>
            <h1>{draft.name || (isCreate ? 'Untitled team' : 'Agent team')}</h1>
          </div>
        </div>
        <div className="team-forge-header__actions">
          <div className="team-forge-save-state" aria-live="polite">
            {saving ? (
              <span>Synchronizing team configuration…</span>
            ) : layoutSettling ? (
              <span>Aligning team layout…</span>
            ) : !validation.valid ? (
              <span className="is-incomplete"><i />Team setup incomplete</span>
            ) : dirty ? (
              <span className="is-dirty"><i />Draft modified</span>
            ) : (
              <span>{notice || 'Draft synchronized'}</span>
            )}
          </div>
          <button type="submit" className="agent-primary-button" disabled={!validation.valid || saving || layoutSettling || returning || editorLocked || (!isCreate && !dirty)}>
            <span aria-hidden="true" className="material-symbols-outlined">save</span>
            {saving ? 'Saving…' : isCreate ? 'Create team' : 'Save changes'}
          </button>
        </div>
      </header>

      <AnimatePresence initial={false} mode="wait">
        {surface === 'catalog' ? (
          <TeamAgentPalette key="catalog" agents={agents} draft={draft} onAddAgent={addAgent} onCanvasInsetChange={reportCanvasInset} onClose={() => setSurface(null)} returning={returning} />
        ) : null}
        {surface && surface !== 'catalog' ? (
          <TeamInspector
            key={surface}
            agents={agents}
            draft={draft}
            onCanvasInsetChange={reportCanvasInset}
            onClose={() => setSurface(null)}
            onConnectAgents={connectAgents}
            onOpenAgent={openAgent}
            onRemoveEdge={removeEdge}
            onRemoveNode={removeNode}
            onSelect={selectGraphElement}
            onSetEntry={(agentId) => updateDraft((current) => ({ ...current, entry_agent_id: agentId }))}
            onSetField={(field, value) => updateDraft((current) => ({ ...current, [field]: value }))}
            onUpdateEdge={updateEdge}
            returning={returning}
            selection={selection}
            validation={validation}
            view={surface}
          />
        ) : null}
      </AnimatePresence>
      {interactionError || backendError ? (
        <div className="team-forge-error" role="alert">
          <span>{interactionError || backendError}</span>
          <button type="button" onClick={() => {
            setInteractionError(null)
            setBackendError(null)
          }}>Dismiss</button>
        </div>
      ) : null}
    </form>
  )
}
