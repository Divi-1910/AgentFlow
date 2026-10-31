import { useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { getAgentReadiness, getSelectedAgentCapabilities } from '../../features/agents/agentForgeGraph'
import { AgentConfigNode, AgentForgeNode } from './AgentForgeNode'

const canvasLayoutProfiles = {
  forge: {
    baseRadius: 340,
    capabilitySize: { height: 104, width: 218 },
    corePosition: { x: 420, y: 250 },
    coreSize: { height: 240, width: 310 },
    fitPadding: 0.2,
    minimumDistance: 238,
    minZoom: 0.3,
    nodesPerRing: 8,
    ringStep: 185,
    spawnOffsetX: 45,
    spawnOffsetY: 25,
    spawnScale: 1.32,
  },
  library: {
    baseRadius: 258,
    capabilitySize: { height: 96, width: 188 },
    corePosition: { x: 420, y: 230 },
    coreSize: { height: 220, width: 280 },
    fitPadding: 0.14,
    minimumDistance: 196,
    minZoom: 0.36,
    nodesPerRing: 8,
    ringStep: 160,
    spawnOffsetX: 34,
    spawnOffsetY: 18,
    spawnScale: 1.24,
  },
}

const nodeTypes = {
  agent: AgentForgeNode,
  capability: AgentConfigNode,
}

function isCapabilityNode(node) {
  return node.type === 'capability'
}

function capabilityAnchor(index, total, layout) {
  const {
    baseRadius,
    capabilitySize,
    corePosition,
    coreSize,
    nodesPerRing,
    ringStep,
  } = layout
  const ring = Math.floor(index / nodesPerRing)
  const ringStart = ring * nodesPerRing
  const countOnRing = Math.min(nodesPerRing, total - ringStart)
  const positionOnRing = index - ringStart
  const angle = (-Math.PI / 2) + ((Math.PI * 2 * positionOnRing) / Math.max(countOnRing, 1))
  const radius = baseRadius + (ring * ringStep)
  const coreCenterX = corePosition.x + (coreSize.width / 2)
  const coreCenterY = corePosition.y + (coreSize.height / 2)

  return {
    x: coreCenterX + (Math.cos(angle) * radius) - (capabilitySize.width / 2),
    y: coreCenterY + (Math.sin(angle) * radius) - (capabilitySize.height / 2),
  }
}

function capabilitySpawn(anchor, index, layout) {
  const {
    capabilitySize,
    corePosition,
    coreSize,
    spawnOffsetX,
    spawnOffsetY,
    spawnScale,
  } = layout
  const coreCenterX = corePosition.x + (coreSize.width / 2)
  const coreCenterY = corePosition.y + (coreSize.height / 2)
  const anchorCenterX = anchor.x + (capabilitySize.width / 2)
  const anchorCenterY = anchor.y + (capabilitySize.height / 2)
  const direction = index % 2 === 0 ? 1 : -1

  return {
    x: coreCenterX + ((anchorCenterX - coreCenterX) * spawnScale) - (capabilitySize.width / 2) + (direction * spawnOffsetX),
    y: coreCenterY + ((anchorCenterY - coreCenterY) * spawnScale) - (capabilitySize.height / 2) - (direction * spawnOffsetY),
  }
}

function buildCapabilityNodes({
  form,
  identity,
  interactionDisabled,
  layout,
  mcpChoices,
  onOpenInspector,
  onSceneTransitionComplete,
  readiness,
  reduceMotion,
  scenePhase,
  toolChoices,
}) {
  const capabilities = getSelectedAgentCapabilities(form, toolChoices, mcpChoices)

  const capabilityNodes = capabilities.map((capability, index) => {
    const anchor = capabilityAnchor(index, capabilities.length, layout)
    return {
      data: {
        anchor,
        detail: capability.description,
        eyebrow: capability.kind,
        icon: capability.icon,
        identity,
        index: capability.index,
        scenePhase,
        title: capability.label,
        tone: capability.tone,
      },
      id: capability.id,
      position: reduceMotion ? anchor : capabilitySpawn(anchor, index, layout),
      type: 'capability',
    }
  })

  return [
    {
      data: {
        disabled: interactionDisabled,
        identity,
        model: form.model,
        name: form.name,
        onOpen: onOpenInspector,
        onSceneTransitionComplete,
        readiness,
        scenePhase,
      },
      draggable: false,
      focusable: false,
      id: 'agent',
      position: layout.corePosition,
      selectable: false,
      type: 'agent',
    },
    ...capabilityNodes,
  ]
}

function edgeHandles(node, layout) {
  const { capabilitySize, corePosition, coreSize } = layout
  const nodeCenterX = node.position.x + (capabilitySize.width / 2)
  const nodeCenterY = node.position.y + (capabilitySize.height / 2)
  const coreCenterX = corePosition.x + (coreSize.width / 2)
  const coreCenterY = corePosition.y + (coreSize.height / 2)
  const deltaX = nodeCenterX - coreCenterX
  const deltaY = nodeCenterY - coreCenterY

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { sourceHandle: 'left', targetHandle: 'right' }
      : { sourceHandle: 'right', targetHandle: 'left' }
  }

  return deltaY >= 0
    ? { sourceHandle: 'top', targetHandle: 'bottom' }
    : { sourceHandle: 'bottom', targetHandle: 'top' }
}

function buildEdges(nodes, activeCapabilityId, layout, reduceMotion, scenePhase) {
  return nodes.filter(isCapabilityNode).map((node) => {
    const active = node.id === activeCapabilityId && !reduceMotion
    const exiting = Boolean(node.data.exiting) || scenePhase === 'exiting'
    return {
      animated: active,
      className: [
        active ? 'agent-forge-edge--active' : '',
        exiting ? 'agent-forge-edge--exiting' : '',
        scenePhase === 'entering' ? 'agent-forge-edge--scene-entering' : '',
      ]
        .filter(Boolean)
        .join(' '),
      focusable: false,
      id: `${node.id}-agent`,
      selectable: false,
      source: node.id,
      style: {
        stroke: active ? 'rgba(255, 255, 255, 0.62)' : 'rgba(255, 255, 255, 0.2)',
        strokeDasharray: node.id.startsWith('mcp:') && !active ? '5 7' : undefined,
        strokeWidth: active ? 1.4 : 1,
        transition: 'opacity 180ms ease',
        opacity: exiting ? 0 : 1,
      },
      target: 'agent',
      type: 'default',
      ...edgeHandles(node, layout),
    }
  })
}

function ViewportSync({ fitPadding, nodeIds, panelOffset, preserveViewport, reduceMotion, viewportSignature }) {
  const { fitView, getViewport, setViewport } = useReactFlow()
  const appliedPanelOffsetRef = useRef(0)
  const previousNodeSignatureRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const frame = window.requestAnimationFrame(async () => {
      const nodeSignatureChanged = previousNodeSignatureRef.current !== viewportSignature
      previousNodeSignatureRef.current = viewportSignature

      if (nodeSignatureChanged && !preserveViewport) {
        await fitView({
          duration: reduceMotion ? 0 : 520,
          maxZoom: 1,
          nodes: ['agent', ...nodeIds].map((id) => ({ id })),
          padding: fitPadding,
        })

        if (cancelled) return
        const fittedViewport = getViewport()
        appliedPanelOffsetRef.current = panelOffset
        await setViewport({
          ...fittedViewport,
          x: fittedViewport.x - panelOffset,
        }, { duration: reduceMotion ? 0 : 360 })
        return
      }

      const offsetDelta = panelOffset - appliedPanelOffsetRef.current
      appliedPanelOffsetRef.current = panelOffset
      if (cancelled || offsetDelta === 0) return

      const viewport = getViewport()
      await setViewport({
        ...viewport,
        x: viewport.x - offsetDelta,
      }, { duration: reduceMotion ? 0 : 360 })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [fitPadding, fitView, getViewport, nodeIds, panelOffset, preserveViewport, reduceMotion, setViewport, viewportSignature])

  return null
}

export default function AgentForgeCanvas({
  dirty = false,
  form,
  identity = 'agent-draft',
  inspectorOpen = false,
  interactionDisabled = false,
  mcpChoices = [],
  mode = 'forge',
  onOpenInspector,
  onSceneTransitionComplete,
  panelPlacement = 'auto',
  preserveViewport = false,
  scenePhase = 'idle',
  toolChoices = [],
}) {
  const reduceMotion = useReducedMotion()
  const layout = canvasLayoutProfiles[mode] || canvasLayoutProfiles.forge
  const readiness = useMemo(() => getAgentReadiness(form), [form])
  const desiredNodes = useMemo(() => buildCapabilityNodes({
    form,
    identity,
    interactionDisabled,
    layout,
    mcpChoices,
    onOpenInspector,
    onSceneTransitionComplete,
    readiness,
    reduceMotion,
    scenePhase,
    toolChoices,
  }), [form, identity, interactionDisabled, layout, mcpChoices, onOpenInspector, onSceneTransitionComplete, readiness, reduceMotion, scenePhase, toolChoices])
  const [nodes, setNodes, onNodesChange] = useNodesState(desiredNodes)
  const [simulationEpoch, setSimulationEpoch] = useState(0)
  const [activeCapabilityId, setActiveCapabilityId] = useState(null)
  const velocitiesRef = useRef(new Map())
  const draggingRef = useRef(new Set())
  const retirementTimersRef = useRef(new Map())

  const capabilityIds = useMemo(
    () => desiredNodes.filter(isCapabilityNode).map((node) => node.id),
    [desiredNodes],
  )
  const capabilitySignature = capabilityIds.join('|')
  const viewportSignature = `${mode}:${capabilitySignature}`
  const resolvedPanelPlacement = panelPlacement === 'auto'
    ? mode === 'library'
      ? 'library'
      : inspectorOpen
        ? 'inspector'
        : 'none'
    : panelPlacement
  const panelOffset = resolvedPanelPlacement === 'library'
    ? Math.min(180, window.innerWidth * 0.12)
    : resolvedPanelPlacement === 'inspector'
      ? Math.min(240, window.innerWidth * 0.16)
      : 0

  useEffect(() => {
    if (scenePhase === 'entering') {
      velocitiesRef.current.clear()
      draggingRef.current.clear()
    }

    setNodes((currentNodes) => {
      if (scenePhase === 'entering') {
        return desiredNodes
      }

      const currentById = new Map(currentNodes.map((node) => [node.id, node]))
      const desiredIds = new Set(desiredNodes.map((node) => node.id))
      const synchronizedNodes = desiredNodes.map((node) => {
        const current = currentById.get(node.id)
        if (!current) return node
        return {
          ...node,
          measured: current.measured,
          position: reduceMotion && isCapabilityNode(node) ? node.data.anchor : current.position,
          selected: current.selected,
        }
      })
      const retiringNodes = currentNodes
        .filter((node) => isCapabilityNode(node) && !desiredIds.has(node.id))
        .map((node) => ({ ...node, data: { ...node.data, exiting: true } }))
      return [...synchronizedNodes, ...retiringNodes]
    })
  }, [desiredNodes, reduceMotion, scenePhase, setNodes])

  useEffect(() => {
    const activeExitingIds = new Set(
      nodes.filter((node) => isCapabilityNode(node) && node.data.exiting).map((node) => node.id),
    )

    for (const [nodeId, timer] of retirementTimersRef.current) {
      if (activeExitingIds.has(nodeId)) continue
      window.clearTimeout(timer)
      retirementTimersRef.current.delete(nodeId)
    }

    if (reduceMotion) {
      if (activeExitingIds.size > 0) {
        setNodes((currentNodes) => currentNodes.filter((node) => !activeExitingIds.has(node.id)))
      }
      return
    }

    for (const nodeId of activeExitingIds) {
      if (retirementTimersRef.current.has(nodeId)) continue
      const timer = window.setTimeout(() => {
        setNodes((currentNodes) => currentNodes.filter((node) => (
          node.id !== nodeId || !node.data.exiting
        )))
        retirementTimersRef.current.delete(nodeId)
      }, 220)
      retirementTimersRef.current.set(nodeId, timer)
    }
  }, [nodes, reduceMotion, setNodes])

  useEffect(() => {
    const retirementTimers = retirementTimersRef.current
    return () => {
      for (const timer of retirementTimers.values()) window.clearTimeout(timer)
      retirementTimers.clear()
    }
  }, [])

  useEffect(() => {
    if (reduceMotion) return undefined

    // Each capability is pulled toward a deterministic orbital anchor while
    // nearby capabilities repel one another. Damping lets the field stop once
    // it settles instead of consuming a permanent animation loop.
    let frame = null
    let lastTime = performance.now()
    let quietFrames = 0
    let active = true

    function step(time) {
      if (!active || document.hidden) {
        frame = null
        return
      }

      const delta = Math.min(Math.max((time - lastTime) / 16.67, 0.35), 1.8)
      lastTime = time
      let energy = 0

      setNodes((currentNodes) => {
        const capabilityNodes = currentNodes.filter(isCapabilityNode)
        const forces = new Map(capabilityNodes.map((node) => [node.id, {
          x: (node.data.anchor.x - node.position.x) * 0.018,
          y: (node.data.anchor.y - node.position.y) * 0.018,
        }]))

        for (let leftIndex = 0; leftIndex < capabilityNodes.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < capabilityNodes.length; rightIndex += 1) {
            const left = capabilityNodes[leftIndex]
            const right = capabilityNodes[rightIndex]
            const deltaX = (right.position.x + (layout.capabilitySize.width / 2)) - (left.position.x + (layout.capabilitySize.width / 2))
            const deltaY = (right.position.y + (layout.capabilitySize.height / 2)) - (left.position.y + (layout.capabilitySize.height / 2))
            const distance = Math.max(Math.hypot(deltaX, deltaY), 1)
            const { minimumDistance } = layout
            if (distance >= minimumDistance) continue

            const strength = (minimumDistance - distance) * 0.014
            const forceX = (deltaX / distance) * strength
            const forceY = (deltaY / distance) * strength
            const leftForce = forces.get(left.id)
            const rightForce = forces.get(right.id)
            leftForce.x -= forceX
            leftForce.y -= forceY
            rightForce.x += forceX
            rightForce.y += forceY
          }
        }

        let changed = false
        const nextNodes = currentNodes.map((node) => {
          if (!isCapabilityNode(node) || draggingRef.current.has(node.id)) return node

          const force = forces.get(node.id)
          const velocity = velocitiesRef.current.get(node.id) || { x: 0, y: 0 }
          velocity.x = (velocity.x + (force.x * delta)) * Math.pow(0.84, delta)
          velocity.y = (velocity.y + (force.y * delta)) * Math.pow(0.84, delta)
          velocitiesRef.current.set(node.id, velocity)

          const movementX = velocity.x * delta
          const movementY = velocity.y * delta
          energy = Math.max(energy, Math.abs(movementX) + Math.abs(movementY))
          if (Math.abs(movementX) < 0.002 && Math.abs(movementY) < 0.002) return node
          changed = true

          return {
            ...node,
            position: {
              x: node.position.x + movementX,
              y: node.position.y + movementY,
            },
          }
        })

        return changed ? nextNodes : currentNodes
      })

      quietFrames = energy < 0.035 ? quietFrames + 1 : 0
      if (quietFrames < 28) frame = window.requestAnimationFrame(step)
      else frame = null
    }

    function onVisibilityChange() {
      if (!document.hidden && frame === null) {
        lastTime = performance.now()
        quietFrames = 0
        frame = window.requestAnimationFrame(step)
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    frame = window.requestAnimationFrame(step)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [capabilitySignature, layout, reduceMotion, setNodes, simulationEpoch])

  useEffect(() => {
    if (reduceMotion || inspectorOpen || capabilityIds.length === 0) return undefined

    let index = 0
    let interval = null
    const frame = window.requestAnimationFrame(() => {
      setActiveCapabilityId(capabilityIds[index])
      interval = window.setInterval(() => {
        index = (index + 1) % capabilityIds.length
        setActiveCapabilityId(capabilityIds[index])
      }, 5200)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [capabilityIds, capabilitySignature, inspectorOpen, reduceMotion])

  function onNodeDragStart(_, node) {
    if (!isCapabilityNode(node)) return
    draggingRef.current.add(node.id)
    velocitiesRef.current.set(node.id, { x: 0, y: 0 })
  }

  function onNodeDragStop(_, node) {
    if (!isCapabilityNode(node)) return
    draggingRef.current.delete(node.id)
    setSimulationEpoch((epoch) => epoch + 1)
  }

  const edges = useMemo(
    () => buildEdges(
      nodes,
      inspectorOpen || reduceMotion || scenePhase !== 'idle' ? null : activeCapabilityId,
      layout,
      reduceMotion,
      scenePhase,
    ),
    [activeCapabilityId, inspectorOpen, layout, nodes, reduceMotion, scenePhase],
  )
  return (
    <section
      className={`agent-forge-canvas agent-forge-canvas--${mode}`}
      data-inspector-open={inspectorOpen ? 'true' : 'false'}
      data-scene-phase={scenePhase}
      aria-label="Agent capability constellation"
    >
      {mode !== 'library' ? (
        <div className="agent-forge-canvas__hud agent-forge-canvas__hud--top agent-forge-canvas__hud--status-only">
          <span>{dirty ? 'Draft modified' : 'Draft synchronized'}</span>
        </div>
      ) : null}

      <ReactFlow
        aria-label="Agent capability canvas"
        attributionPosition="bottom-right"
        deleteKeyCode={null}
        edges={edges}
        edgesFocusable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ maxZoom: 1, padding: layout.fitPadding }}
        maxZoom={1.45}
        minZoom={layout.minZoom}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={!interactionDisabled}
        nodesFocusable
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodesChange={onNodesChange}
        panOnDrag
        preventScrolling
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
      >
        <Background
          color="rgba(255, 255, 255, 0.12)"
          gap={30}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls position="bottom-left" showInteractive={false} />
        <ViewportSync
          fitPadding={layout.fitPadding}
          nodeIds={capabilityIds}
          panelOffset={panelOffset}
          preserveViewport={preserveViewport}
          reduceMotion={reduceMotion}
          viewportSignature={viewportSignature}
        />
      </ReactFlow>

      {mode !== 'library' && interactionDisabled ? (
        <div className="agent-forge-canvas__hud agent-forge-canvas__hud--bottom">
          <span className="material-symbols-outlined" aria-hidden="true">motion_photos_auto</span>
          Synchronizing agent configuration…
        </div>
      ) : null}
    </section>
  )
}
