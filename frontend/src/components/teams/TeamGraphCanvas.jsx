import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  getViewportForBounds,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import {
  delegationId,
  getTeamConnectionError,
  getTeamFocusPath,
  layoutTeamGraph,
  normalizeTeamConnection,
} from '../../features/teams/teamGraph'
import {
  buildTeamCanvasFitPadding,
  calculateTeamCanvasMotionBounds,
  EMPTY_TEAM_CANVAS_INSETS,
  hasTeamCanvasInsets,
  isTeamCanvasBoundsVisible,
  normalizeTeamCanvasInsets,
  teamCanvasInsetsEqual,
} from '../../features/teams/teamCanvasViewport'
import TeamAgentNode from './TeamAgentNode'
import TeamCanvasToolbar from './TeamCanvasToolbar'
import TeamDelegationEdge from './TeamDelegationEdge'
import { stepTeamMagnetism, TEAM_NODE_DIAMETER } from './teamMagnetism'

const nodeTypes = { teamAgent: TeamAgentNode }
const edgeTypes = { delegation: TeamDelegationEdge }
const TEAM_CANVAS_MIN_ZOOM = 0.05

function ViewportSync({
  cameraSignature,
  canvasInsets,
  identity,
  mode,
  motionBounds,
  nodeIds,
  nodesInitialized,
  preserveViewport,
  topologySignature,
}) {
  const { fitView, getViewport, setViewport } = useReactFlow()
  const reduceMotion = useReducedMotion()
  const canvasHeight = useStore((state) => state.height)
  const canvasWidth = useStore((state) => state.width)
  const previousIdentity = useRef(null)
  const previousNodeCount = useRef(0)
  const previousInsets = useRef(EMPTY_TEAM_CANVAS_INSETS)
  const previousTopology = useRef(null)
  const panelSnapshot = useRef(null)

  useEffect(() => {
    let cancelled = false
    const frame = window.requestAnimationFrame(async () => {
      const identityChanged = previousIdentity.current !== identity
      const firstNodeAdded = previousNodeCount.current === 0 && nodeIds.length > 0
      const normalizedInsets = normalizeTeamCanvasInsets(canvasInsets)
      const insetsChanged = !teamCanvasInsetsEqual(previousInsets.current, normalizedInsets)
      const hadPanelInset = hasTeamCanvasInsets(previousInsets.current)
      const hasPanelInset = hasTeamCanvasInsets(normalizedInsets)
      const topologyChanged = previousTopology.current !== topologySignature
      const editorTopologyChanged = mode === 'editor'
        && previousTopology.current !== null
        && previousIdentity.current === identity
        && topologyChanged
      const commitObservedState = () => {
        previousIdentity.current = identity
        previousNodeCount.current = nodeIds.length
        previousInsets.current = normalizedInsets
        previousTopology.current = topologySignature
      }

      if (identityChanged) panelSnapshot.current = null

      // A topology edit can introduce an unmeasured node, so React Flow's
      // measured bounds briefly lag behind the graph. Frame the union of each
      // node's current position and magnetic destination immediately instead.
      if (editorTopologyChanged && motionBounds && canvasWidth > 0 && canvasHeight > 0) {
        commitObservedState()
        const viewport = getViewport()
        await setViewport(getViewportForBounds(
          motionBounds,
          canvasWidth,
          canvasHeight,
          TEAM_CANVAS_MIN_ZOOM,
          Math.min(1.05, viewport.zoom),
          buildTeamCanvasFitPadding(normalizedInsets),
        ), { duration: reduceMotion ? 0 : 420 })
        return
      }

      if ((identityChanged || firstNodeAdded) && nodeIds.length > 0 && !nodesInitialized) return
      commitObservedState()

      if (((identityChanged && !preserveViewport) || firstNodeAdded) && nodeIds.length > 0) {
        await fitView({
          duration: reduceMotion ? 0 : mode === 'library' ? 300 : 520,
          maxZoom: 1.05,
          minZoom: TEAM_CANVAS_MIN_ZOOM,
          nodes: nodeIds.map((id) => ({ id })),
          padding: buildTeamCanvasFitPadding(normalizedInsets),
        })
        return
      }

      if (cancelled) return
      if (nodeIds.length === 0) return
      if (!insetsChanged && !(mode !== 'editor' && hasPanelInset && topologyChanged)) return

      if (!hadPanelInset && hasPanelInset) {
        panelSnapshot.current = { cameraSignature, viewport: getViewport() }
      }

      if (hadPanelInset && !hasPanelInset) {
        const snapshot = panelSnapshot.current
        panelSnapshot.current = null
        if (snapshot?.cameraSignature === cameraSignature) {
          await setViewport(snapshot.viewport, { duration: reduceMotion ? 0 : 360 })
          return
        }
        await fitView({
          duration: reduceMotion ? 0 : 460,
          maxZoom: 1.05,
          minZoom: TEAM_CANVAS_MIN_ZOOM,
          nodes: nodeIds.map((id) => ({ id })),
          padding: buildTeamCanvasFitPadding(EMPTY_TEAM_CANVAS_INSETS),
        })
        return
      }

      const viewport = getViewport()
      await fitView({
        duration: reduceMotion ? 0 : 420,
        maxZoom: Math.min(1.05, viewport.zoom),
        minZoom: TEAM_CANVAS_MIN_ZOOM,
        nodes: nodeIds.map((id) => ({ id })),
        padding: buildTeamCanvasFitPadding(normalizedInsets),
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [cameraSignature, canvasHeight, canvasInsets, canvasWidth, fitView, getViewport, identity, mode, motionBounds, nodeIds, nodesInitialized, preserveViewport, reduceMotion, setViewport, topologySignature])

  return null
}

function TeamGraphCanvasContent({
  agents = [],
  canvasInsets = EMPTY_TEAM_CANVAS_INSETS,
  draft,
  identity = 'team-workspace',
  interactionDisabled = true,
  layoutPersistenceEnabled = false,
  mode = 'library',
  onAddAgent,
  onConnectionRejected,
  onConnectAgents,
  onOpenCatalog,
  onOpenReview,
  onOpenTeam,
  onLayoutActivityChange,
  onPositionsSettled,
  onSceneTransitionComplete,
  onSelect,
  preserveViewport = false,
  scenePhase = 'idle',
  selection = { id: null, type: 'team' },
}) {
  const { fitView, getViewport, screenToFlowPosition, setViewport } = useReactFlow()
  const reduceMotion = useReducedMotion()
  const canvasHeight = useStore((state) => state.height)
  const canvasWidth = useStore((state) => state.width)
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const focusPath = useMemo(() => getTeamFocusPath(draft, selection), [draft, selection])
  const outgoingCounts = useMemo(() => {
    const counts = new Map()
    for (const edge of draft.edges || []) counts.set(edge.source_agent_id, (counts.get(edge.source_agent_id) || 0) + 1)
    return counts
  }, [draft.edges])
  const incomingCounts = useMemo(() => {
    const counts = new Map()
    for (const edge of draft.edges || []) counts.set(edge.target_agent_id, (counts.get(edge.target_agent_id) || 0) + 1)
    return counts
  }, [draft.edges])
  const portUsageByAgent = useMemo(() => {
    const usage = new Map()

    const recordPort = (agentId, port, direction) => {
      const agentUsage = usage.get(agentId) || {}
      const portUsage = agentUsage[port] || { incoming: 0, outgoing: 0 }
      usage.set(agentId, {
        ...agentUsage,
        [port]: {
          ...portUsage,
          [direction]: portUsage[direction] + 1,
        },
      })
    }

    for (const edge of draft.edges || []) {
      recordPort(edge.source_agent_id, edge.source_port || 'right', 'outgoing')
      recordPort(edge.target_agent_id, edge.target_port || 'left', 'incoming')
    }

    return usage
  }, [draft.edges])
  // Magnetic anchors are an editor aid. Library is a read-only projection of
  // the persisted coordinates and must never derive an alternative layout.
  const alignedDraft = useMemo(() => mode === 'editor' ? layoutTeamGraph(draft) : draft, [draft, mode])
  const alignmentAnchors = useMemo(() => new Map(
    (alignedDraft.nodes || []).map((node) => [node.agent_id, node.position]),
  ), [alignedDraft.nodes])
  const desiredNodes = useMemo(() => (draft.nodes || []).map((node, index) => ({
    data: {
      agent: agentsById.get(node.agent_id),
      anchor: mode === 'editor' ? (alignmentAnchors.get(node.agent_id) || node.position) : node.position,
      dimmed: Boolean(focusPath && !focusPath.nodeIds.has(node.agent_id)),
      entry: draft.entry_agent_id === node.agent_id,
      focused: Boolean(focusPath?.nodeIds.has(node.agent_id)),
      incomingCount: incomingCounts.get(node.agent_id) || 0,
      onSceneTransitionComplete,
      outgoingCount: outgoingCounts.get(node.agent_id) || 0,
      portUsage: portUsageByAgent.get(node.agent_id) || {},
      sceneAnchor: scenePhase === 'entering'
        ? index === (draft.nodes || []).length - 1
        : index === 0,
      sceneIdentity: identity,
      sceneIndex: index,
      scenePhase,
    },
    draggable: mode === 'editor' && !interactionDisabled,
    id: node.agent_id,
    position: node.position,
    selected: selection.type === 'node' && selection.id === node.agent_id,
    type: 'teamAgent',
  })), [agentsById, alignmentAnchors, draft.entry_agent_id, draft.nodes, focusPath, identity, incomingCounts, interactionDisabled, mode, onSceneTransitionComplete, outgoingCounts, portUsageByAgent, scenePhase, selection.id, selection.type])
  const [nodes, setNodes, onNodesChange] = useNodesState(desiredNodes)
  const [simulationEpoch, setSimulationEpoch] = useState(0)
  const velocitiesRef = useRef(new Map())
  const draggingRef = useRef(new Set())
  const nodesRef = useRef(desiredNodes)
  const pendingTopologyCameraRef = useRef(false)
  const renderedIdentityRef = useRef(null)
  const shouldPersistSettledLayoutRef = useRef(false)
  const simulationActiveRef = useRef(false)
  const topologyTrackerRef = useRef(null)

  const setLayoutActivity = useCallback((active) => {
    if (simulationActiveRef.current === active) return
    simulationActiveRef.current = active
    onLayoutActivityChange?.(active)
  }, [onLayoutActivityChange])

  useEffect(() => {
    const resetPositions = renderedIdentityRef.current !== identity || scenePhase === 'entering'
    renderedIdentityRef.current = identity
    if (resetPositions) {
      velocitiesRef.current.clear()
      draggingRef.current.clear()
    }
    setNodes((currentNodes) => {
      if (resetPositions || mode === 'library') {
        nodesRef.current = desiredNodes
        return desiredNodes
      }
      const currentById = new Map(currentNodes.map((node) => [node.id, node]))
      const nextNodes = desiredNodes.map((desiredNode) => {
        const currentNode = currentById.get(desiredNode.id)
        if (!currentNode) return desiredNode
        return {
          ...desiredNode,
          measured: currentNode.measured,
          position: currentNode.position,
        }
      })
      nodesRef.current = nextNodes
      return nextNodes
    })
  }, [desiredNodes, identity, mode, scenePhase, setNodes])
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  const renderedNodes = mode === 'library' ? desiredNodes : nodes
  const edges = useMemo(() => (draft.edges || []).map((edge) => {
    const id = delegationId(edge.source_agent_id, edge.target_agent_id)
    return {
      data: {
        condition: edge.description,
        dimmed: Boolean(focusPath && !focusPath.edgeIds.has(id)),
        focused: Boolean(focusPath?.edgeIds.has(id)),
        labelVisible: (selection.type === 'edge' && selection.id === id)
          || (selection.type === 'node' && (edge.source_agent_id === selection.id || edge.target_agent_id === selection.id)),
        onSelect: (edgeId) => onSelect?.({ id: edgeId, type: 'edge' }),
        scenePhase,
        sourceName: agentsById.get(edge.source_agent_id)?.name,
        targetName: agentsById.get(edge.target_agent_id)?.name,
      },
      id,
      markerEnd: { color: focusPath && !focusPath.edgeIds.has(id) ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.48)', height: 16, type: MarkerType.ArrowClosed, width: 16 },
      selected: selection.type === 'edge' && selection.id === id,
      source: edge.source_agent_id,
      sourceHandle: edge.source_port || 'right',
      target: edge.target_agent_id,
      targetHandle: edge.target_port || 'left',
      type: 'delegation',
    }
  }), [agentsById, draft.edges, focusPath, onSelect, scenePhase, selection.id, selection.type])
  const magneticEdges = useMemo(() => (draft.edges || []).map((edge) => ({
    source: edge.source_agent_id,
    sourcePort: edge.source_port || 'right',
    target: edge.target_agent_id,
    targetPort: edge.target_port || 'left',
  })), [draft.edges])
  const topologySignature = useMemo(() => [
    identity,
    draft.entry_agent_id,
    ...(draft.nodes || []).map((node) => node.agent_id),
    ...magneticEdges.map((edge) => `${edge.source}:${edge.sourcePort}>${edge.target}:${edge.targetPort}`),
  ].join('|'), [draft.entry_agent_id, draft.nodes, identity, magneticEdges])
  const cameraSignature = useMemo(() => [
    topologySignature,
    ...(draft.nodes || []).map((node) => `${node.agent_id}:${node.position?.x || 0},${node.position?.y || 0}`),
  ].join('|'), [draft.nodes, topologySignature])
  const nodeIds = useMemo(() => (draft.nodes || []).map((node) => node.agent_id), [draft.nodes])
  const normalizedCanvasInsets = useMemo(() => normalizeTeamCanvasInsets(canvasInsets), [canvasInsets])
  const safeFitPadding = useMemo(() => buildTeamCanvasFitPadding(normalizedCanvasInsets), [normalizedCanvasInsets])
  const motionBounds = useMemo(
    () => calculateTeamCanvasMotionBounds(desiredNodes, TEAM_NODE_DIAMETER),
    [desiredNodes],
  )
  const nodesInitialized = useNodesInitialized()

  const ensureTopologyLayoutVisible = useCallback((settledNodes) => {
    if (!pendingTopologyCameraRef.current) return
    pendingTopologyCameraRef.current = false
    if (!Array.isArray(settledNodes) || settledNodes.length === 0 || canvasWidth <= 0 || canvasHeight <= 0) return

    const bounds = calculateTeamCanvasMotionBounds(settledNodes.map((node) => ({
      data: { anchor: node.position },
      position: node.position,
    })), TEAM_NODE_DIAMETER)
    if (!bounds) return

    const viewport = getViewport()
    if (isTeamCanvasBoundsVisible({
      bounds,
      containerHeight: canvasHeight,
      containerWidth: canvasWidth,
      insets: normalizedCanvasInsets,
      viewport,
    })) return

    void setViewport(getViewportForBounds(
      bounds,
      canvasWidth,
      canvasHeight,
      TEAM_CANVAS_MIN_ZOOM,
      Math.min(1.05, viewport.zoom),
      safeFitPadding,
    ), { duration: reduceMotion ? 0 : 280 })
  }, [canvasHeight, canvasWidth, getViewport, normalizedCanvasInsets, reduceMotion, safeFitPadding, setViewport])

  useEffect(() => {
    // Existing saved graphs remain still. Only a Forge topology change wakes
    // the field and creates a new layout that must settle before it can save.
    const previous = topologyTrackerRef.current
    const persistenceActive = mode === 'editor' && layoutPersistenceEnabled
    if (!persistenceActive || (previous && previous.identity !== identity)) {
      shouldPersistSettledLayoutRef.current = false
      pendingTopologyCameraRef.current = false
      setLayoutActivity(false)
    }
    if (
      persistenceActive
      && previous?.persistenceActive
      && previous.identity === identity
      && previous.signature !== topologySignature
    ) {
      const hasNodesToSettle = desiredNodes.length > 0
      shouldPersistSettledLayoutRef.current = hasNodesToSettle
      pendingTopologyCameraRef.current = hasNodesToSettle
      setLayoutActivity(hasNodesToSettle)
    }
    topologyTrackerRef.current = {
      identity,
      persistenceActive,
      signature: topologySignature,
    }
  }, [desiredNodes, identity, layoutPersistenceEnabled, mode, setLayoutActivity, topologySignature])

  useEffect(() => {
    if (
      mode !== 'editor'
      || !reduceMotion
      || !simulationActiveRef.current
      || draggingRef.current.size > 0
      || !shouldPersistSettledLayoutRef.current
      || !onPositionsSettled
    ) return
    shouldPersistSettledLayoutRef.current = false
    onPositionsSettled(Object.fromEntries((alignedDraft.nodes || []).map((node) => [node.agent_id, node.position])))
    ensureTopologyLayoutVisible((alignedDraft.nodes || []).map((node) => ({ position: node.position })))
    setLayoutActivity(false)
  }, [alignedDraft.nodes, ensureTopologyLayoutVisible, mode, onPositionsSettled, reduceMotion, setLayoutActivity, simulationEpoch, topologySignature])

  useEffect(() => {
    if (mode !== 'editor' || reduceMotion || !simulationActiveRef.current || desiredNodes.length === 0) return undefined

    let active = true
    let frame = null
    let lastTime = performance.now()
    let quietFrames = 0

    function step(time) {
      if (!active || document.hidden) {
        frame = null
        return
      }

      // React Flow must be the only writer while the pointer owns a node.
      // Publishing the simulation's node array here would restore the last
      // physics coordinate over React Flow's live drag coordinate.
      if (draggingRef.current.size > 0) {
        lastTime = time
        quietFrames = 0
        frame = window.requestAnimationFrame(step)
        return
      }

      const delta = Math.min(Math.max((time - lastTime) / 16.67, 0.35), 1.8)
      lastTime = time
      const result = stepTeamMagnetism({
        delta,
        draggingIds: draggingRef.current,
        edges: magneticEdges,
        nodes: nodesRef.current,
        velocities: velocitiesRef.current,
      })
      velocitiesRef.current = result.velocities
      nodesRef.current = result.nodes
      setNodes(result.nodes)

      quietFrames = result.energy < 0.025 ? quietFrames + 1 : 0
      if (quietFrames < 28) {
        frame = window.requestAnimationFrame(step)
        return
      }

      frame = null
      if (shouldPersistSettledLayoutRef.current && onPositionsSettled) {
        shouldPersistSettledLayoutRef.current = false
        onPositionsSettled(Object.fromEntries(result.nodes.map((node) => [node.id, {
          x: Math.round(node.position.x * 100) / 100,
          y: Math.round(node.position.y * 100) / 100,
        }])))
        ensureTopologyLayoutVisible(result.nodes)
      }
      setLayoutActivity(false)
    }

    function resumeWhenVisible() {
      if (!document.hidden && frame === null) {
        lastTime = performance.now()
        quietFrames = 0
        frame = window.requestAnimationFrame(step)
      }
    }

    document.addEventListener('visibilitychange', resumeWhenVisible)
    frame = window.requestAnimationFrame(step)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', resumeWhenVisible)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [desiredNodes.length, ensureTopologyLayoutVisible, magneticEdges, mode, onPositionsSettled, reduceMotion, setLayoutActivity, setNodes, simulationEpoch, topologySignature])

  const connectionError = useCallback((connection) => {
    return getTeamConnectionError(draft, connection.source, connection.target)
  }, [draft])

  const isValidConnection = useCallback((connection) => !connectionError(connection), [connectionError])

  const handleConnect = useCallback((connection) => {
    if (interactionDisabled || mode !== 'editor') return
    const error = connectionError(connection)
    if (error) {
      onConnectionRejected?.(error)
      return
    }
    const normalized = normalizeTeamConnection(connection)
    onConnectAgents?.(normalized.sourceAgentId, normalized.targetAgentId, normalized.sourcePort, normalized.targetPort)
  }, [connectionError, interactionDisabled, mode, onConnectAgents, onConnectionRejected])

  const handleConnectEnd = useCallback((_, state) => {
    if (!state.fromHandle || !state.toHandle || state.isValid) return
    onConnectionRejected?.(connectionError({
      source: state.fromHandle.nodeId,
      sourceHandle: state.fromHandle.id,
      target: state.toHandle.nodeId,
      targetHandle: state.toHandle.id,
    }))
  }, [connectionError, onConnectionRejected])

  const handleDrop = useCallback((event) => {
    if (interactionDisabled || mode !== 'editor') return
    event.preventDefault()
    const agentId = event.dataTransfer.getData('application/agentflow-agent')
    if (!agentId) return
    onAddAgent?.(agentId, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [interactionDisabled, mode, onAddAgent, screenToFlowPosition])

  const fitGraph = useCallback(() => {
    if (nodeIds.length === 0) return
    fitView({
      duration: 420,
      maxZoom: 1.05,
      minZoom: TEAM_CANVAS_MIN_ZOOM,
      nodes: nodeIds.map((id) => ({ id })),
      padding: safeFitPadding,
    })
  }, [fitView, nodeIds, safeFitPadding])

  const focusAgent = useCallback((agentId) => {
    fitView({
      duration: 380,
      maxZoom: 1.12,
      minZoom: mode === 'editor' ? 0.1 : 0.72,
      nodes: [{ id: agentId }],
      padding: safeFitPadding,
    })
    if (mode === 'editor') onSelect?.({ id: agentId, type: 'node' })
  }, [fitView, mode, onSelect, safeFitPadding])

  const handleNodeDragStart = useCallback((_, node) => {
    if (mode !== 'editor' || !layoutPersistenceEnabled) return
    draggingRef.current.add(node.id)
    velocitiesRef.current.set(node.id, { x: 0, y: 0 })
    shouldPersistSettledLayoutRef.current = true
    setLayoutActivity(true)
    setSimulationEpoch((epoch) => epoch + 1)
  }, [layoutPersistenceEnabled, mode, setLayoutActivity])

  const handleNodeDragStop = useCallback((_, node) => {
    if (mode !== 'editor' || !layoutPersistenceEnabled) return
    draggingRef.current.delete(node.id)
    nodesRef.current = nodesRef.current.map((currentNode) => (
      currentNode.id === node.id ? { ...currentNode, position: node.position } : currentNode
    ))
    setSimulationEpoch((epoch) => epoch + 1)
  }, [layoutPersistenceEnabled, mode])

  return (
    <div
      className={`team-graph-canvas team-graph-canvas--${mode}`}
      style={{
        '--team-canvas-safe-bottom': `${normalizedCanvasInsets.bottom}px`,
        '--team-canvas-safe-left': `${normalizedCanvasInsets.left}px`,
        '--team-canvas-safe-right': `${normalizedCanvasInsets.right}px`,
        '--team-canvas-safe-shift-x': `${(normalizedCanvasInsets.left - normalizedCanvasInsets.right) / 2}px`,
        '--team-canvas-safe-shift-y': `${(normalizedCanvasInsets.top - normalizedCanvasInsets.bottom) / 2}px`,
        '--team-canvas-safe-top': `${normalizedCanvasInsets.top}px`,
      }}
      onDragOver={(event) => {
        if (mode === 'editor') {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={handleDrop}
    >
      <ReactFlow
        colorMode="dark"
        connectionMode={ConnectionMode.Loose}
        connectOnClick={false}
        defaultEdgeOptions={{ type: 'delegation' }}
        deleteKeyCode={null}
        edgeTypes={edgeTypes}
        edges={edges}
        elementsSelectable={!interactionDisabled}
        fitView={false}
        maxZoom={1.35}
        minZoom={TEAM_CANVAS_MIN_ZOOM}
        nodeTypes={nodeTypes}
        nodes={renderedNodes}
        nodesConnectable={mode === 'editor' && !interactionDisabled}
        nodesDraggable={mode === 'editor' && !interactionDisabled}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onEdgeClick={(_, edge) => onSelect?.({ id: edge.id, type: 'edge' })}
        onNodeClick={(_, node) => onSelect?.({ id: node.id, type: 'node' })}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={onNodesChange}
        onPaneClick={() => onSelect?.({ id: null, type: 'team' })}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        isValidConnection={isValidConnection}
        zoomOnDoubleClick={false}
        zoomOnScroll
      >
        <Background color="rgba(255,255,255,0.12)" gap={30} size={1} variant={BackgroundVariant.Dots} />
        <Controls className="team-canvas-controls" fitViewOptions={{ minZoom: TEAM_CANVAS_MIN_ZOOM, padding: safeFitPadding }} position="bottom-left" showInteractive={false} />
        <MiniMap
          className="team-canvas-minimap"
          maskColor="rgba(0,0,0,0.66)"
          nodeColor={(node) => node.data?.entry ? '#ffffff' : node.data?.dimmed ? '#343434' : '#858585'}
          nodeStrokeColor="rgba(255,255,255,0.28)"
          pannable
          position="bottom-right"
          style={{ height: 84, width: 132 }}
          zoomable
        />
        <ViewportSync
          cameraSignature={cameraSignature}
          canvasInsets={normalizedCanvasInsets}
          identity={identity}
          mode={mode}
          motionBounds={motionBounds}
          nodeIds={nodeIds}
          nodesInitialized={nodesInitialized}
          preserveViewport={preserveViewport}
          topologySignature={topologySignature}
        />
      </ReactFlow>
      <TeamCanvasToolbar
        agents={agents}
        draft={draft}
        mode={mode}
        onFitGraph={fitGraph}
        onFocusAgent={focusAgent}
        onOpenCatalog={onOpenCatalog}
        onOpenReview={onOpenReview}
        onOpenTeam={onOpenTeam}
      />
      {renderedNodes.length === 0 ? (
        <div className="team-canvas-empty" aria-live="polite">
          <span aria-hidden="true" className="material-symbols-outlined">account_tree</span>
          <strong>{mode === 'editor' ? 'Build the request path' : 'No Agents in this Team'}</strong>
          {mode === 'editor' ? (
            <>
              <p><span>1</span> Add the starting Agent <i /> <span>2</span> Add specialists <i /> <span>3</span> Define when they help</p>
              <button type="button" className="agent-primary-button" onClick={onOpenCatalog}>
                <span aria-hidden="true" className="material-symbols-outlined">add</span>
                Add first Agent
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default function TeamGraphCanvas(props) {
  return (
    <ReactFlowProvider>
      <TeamGraphCanvasContent {...props} />
    </ReactFlowProvider>
  )
}
