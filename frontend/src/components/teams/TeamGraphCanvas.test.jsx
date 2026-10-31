import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TeamGraphCanvas from './TeamGraphCanvas'

const canvasMocks = vi.hoisted(() => ({
  fitView: vi.fn(async () => {}),
  getNodesBounds: vi.fn(() => ({ height: 400, width: 400, x: 0, y: 0 })),
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
  getViewportForBounds: vi.fn(() => ({ x: 20, y: 30, zoom: 0.72 })),
  renderSnapshots: [],
  setViewport: vi.fn(async () => {}),
  stepTeamMagnetism: vi.fn(({ nodes, velocities }) => ({
    changed: false,
    energy: 0,
    nodes,
    velocities,
  })),
}))

vi.mock('framer-motion', () => ({ useReducedMotion: () => false }))
vi.mock('./teamMagnetism', () => ({
  stepTeamMagnetism: canvasMocks.stepTeamMagnetism,
  TEAM_NODE_DIAMETER: 112,
}))
vi.mock('./TeamAgentNode', () => ({ default: () => null }))
vi.mock('./TeamCanvasToolbar', () => ({ default: () => null }))
vi.mock('./TeamDelegationEdge', () => ({ default: () => null }))
vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  return {
    Background: () => null,
    BackgroundVariant: { Dots: 'dots' },
    ConnectionMode: { Loose: 'loose' },
    Controls: () => null,
    getViewportForBounds: canvasMocks.getViewportForBounds,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    MiniMap: ({ style }) => <div data-testid="team-minimap" data-size={`${style.width}x${style.height}`} />,
    ReactFlow: ({ children, edges, nodes }) => {
      canvasMocks.renderSnapshots.push({
        edgeIds: edges.map((edge) => `${edge.source}>${edge.target}`),
        nodeIds: nodes.map((node) => node.id),
      })
      return (
        <div
          data-testid="rendered-team-nodes"
          data-edge-handles={JSON.stringify(edges.map((edge) => ({
            id: edge.id,
            sourceHandle: edge.sourceHandle,
            targetHandle: edge.targetHandle,
          })))}
          data-edge-scenes={JSON.stringify(edges.map((edge) => edge.data.scenePhase))}
          data-port-usage={JSON.stringify(Object.fromEntries(nodes.map((node) => [node.id, node.data.portUsage])))}
          data-positions={JSON.stringify(nodes.map((node) => node.position))}
          data-scene-anchors={JSON.stringify(nodes.map((node) => node.data.sceneAnchor))}
          data-scene-identities={JSON.stringify(nodes.map((node) => node.data.sceneIdentity))}
        >
          {children}
        </div>
      )
    },
    ReactFlowProvider: ({ children }) => children,
    useNodesState: (initialNodes) => {
      const [nodes, setNodes] = React.useState(initialNodes)
      return [nodes, setNodes, vi.fn()]
    },
    useNodesInitialized: () => true,
    useReactFlow: () => ({
      fitView: canvasMocks.fitView,
      getNodesBounds: canvasMocks.getNodesBounds,
      getViewport: canvasMocks.getViewport,
      screenToFlowPosition: (position) => position,
      setViewport: canvasMocks.setViewport,
    }),
    useStore: (selector) => selector({ height: 800, width: 1200 }),
  }
})

const agents = [
  { id: 'lead', name: 'Lead' },
  { id: 'writer', name: 'Writer' },
  { id: 'reviewer', name: 'Reviewer' },
]

const draft = {
  description: '',
  entry_agent_id: 'lead',
  name: 'Editorial team',
  nodes: [
    { agent_id: 'lead', position: { x: 710, y: -180 } },
    { agent_id: 'writer', position: { x: 90, y: 640 } },
  ],
  edges: [{
    description: '',
    instructions: '',
    source_agent_id: 'lead',
    source_port: 'right',
    target_agent_id: 'writer',
    target_port: 'left',
    tool_name: 'delegate_to_writer',
  }],
}

describe('TeamGraphCanvas layout ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback) => window.setTimeout(() => callback(performance.now()), 1))
    vi.stubGlobal('cancelAnimationFrame', (frame) => window.clearTimeout(frame))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    canvasMocks.fitView.mockClear()
    canvasMocks.getNodesBounds.mockClear()
    canvasMocks.getViewport.mockClear()
    canvasMocks.getViewportForBounds.mockClear()
    canvasMocks.renderSnapshots.length = 0
    canvasMocks.setViewport.mockClear()
    canvasMocks.stepTeamMagnetism.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders saved Library coordinates without starting magnetic layout', async () => {
    render(<TeamGraphCanvas agents={agents} draft={draft} identity="team-1" mode="library" />)

    expect(JSON.parse(screen.getByTestId('rendered-team-nodes').dataset.positions)).toEqual([
      { x: 710, y: -180 },
      { x: 90, y: 640 },
    ])
    expect(screen.getByTestId('team-minimap').dataset.size).toBe('132x84')
    await new Promise((resolve) => window.setTimeout(resolve, 30))
    expect(canvasMocks.stepTeamMagnetism).not.toHaveBeenCalled()
  })

  it('keeps an existing Forge layout still until its topology changes', async () => {
    const onLayoutActivityChange = vi.fn()
    const { rerender } = render(
      <TeamGraphCanvas
        agents={agents}
        draft={draft}
        identity="team-1"
        layoutPersistenceEnabled
        mode="editor"
        onLayoutActivityChange={onLayoutActivityChange}
        onPositionsSettled={vi.fn()}
      />,
    )

    await new Promise((resolve) => window.setTimeout(resolve, 30))
    expect(canvasMocks.stepTeamMagnetism).not.toHaveBeenCalled()
    canvasMocks.setViewport.mockClear()

    rerender(
      <TeamGraphCanvas
        agents={agents}
        draft={{
          ...draft,
          nodes: [...draft.nodes, { agent_id: 'reviewer', position: { x: 440, y: 700 } }],
        }}
        identity="team-1"
        layoutPersistenceEnabled
        mode="editor"
        onLayoutActivityChange={onLayoutActivityChange}
        onPositionsSettled={vi.fn()}
      />,
    )

    await waitFor(() => expect(canvasMocks.stepTeamMagnetism).toHaveBeenCalled())
    expect(onLayoutActivityChange).toHaveBeenCalledWith(true)
    await waitFor(() => expect(canvasMocks.getViewportForBounds).toHaveBeenCalled())
    expect(canvasMocks.setViewport).toHaveBeenCalledWith(
      { x: 20, y: 30, zoom: 0.72 },
      { duration: 420 },
    )
  })

  it('publishes Library nodes, edges, and scene identity atomically during a Team switch', () => {
    const { rerender } = render(
      <TeamGraphCanvas agents={agents} draft={draft} identity="team-1" mode="library" scenePhase="exiting" />,
    )

    const incomingDraft = {
      ...draft,
      name: 'Review team',
      nodes: [
        { agent_id: 'writer', position: { x: 520, y: 120 } },
        { agent_id: 'reviewer', position: { x: 800, y: 120 } },
      ],
      entry_agent_id: 'writer',
      edges: [{
        description: '',
        instructions: '',
        source_agent_id: 'writer',
        source_port: 'right',
        target_agent_id: 'reviewer',
        target_port: 'left',
        tool_name: 'delegate_to_reviewer',
      }],
    }

    canvasMocks.renderSnapshots.length = 0
    rerender(
      <TeamGraphCanvas agents={agents} draft={incomingDraft} identity="team-2" mode="library" scenePhase="entering" />,
    )

    const canvas = screen.getByTestId('rendered-team-nodes')
    expect(JSON.parse(canvas.dataset.positions)).toEqual([
      { x: 520, y: 120 },
      { x: 800, y: 120 },
    ])
    expect(JSON.parse(canvas.dataset.edgeHandles)).toEqual([{
      id: 'writer::reviewer',
      sourceHandle: 'right',
      targetHandle: 'left',
    }])
    expect(JSON.parse(canvas.dataset.edgeScenes)).toEqual(['entering'])
    expect(JSON.parse(canvas.dataset.sceneIdentities)).toEqual(['team-2', 'team-2'])
    expect(JSON.parse(canvas.dataset.sceneAnchors)).toEqual([false, true])
    expect(canvasMocks.renderSnapshots.length).toBeGreaterThan(0)
    expect(canvasMocks.renderSnapshots.every((snapshot) => (
      snapshot.nodeIds.join('|') === 'writer|reviewer'
      && snapshot.edgeIds.join('|') === 'writer>reviewer'
    ))).toBe(true)
  })

  it('projects saved edge ports into React Flow handles and node port states', async () => {
    const bottomToTopDraft = {
      ...draft,
      edges: [{
        ...draft.edges[0],
        source_port: 'bottom',
        target_port: 'top',
      }],
    }
    const { rerender } = render(
      <TeamGraphCanvas agents={agents} draft={bottomToTopDraft} identity="team-ports" mode="library" />,
    )

    const canvas = screen.getByTestId('rendered-team-nodes')
    expect(JSON.parse(canvas.dataset.edgeHandles)).toEqual([{
      id: 'lead::writer',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    }])
    expect(JSON.parse(canvas.dataset.portUsage)).toEqual({
      lead: { bottom: { incoming: 0, outgoing: 1 } },
      writer: { top: { incoming: 1, outgoing: 0 } },
    })

    rerender(
      <TeamGraphCanvas
        agents={agents}
        draft={{
          ...bottomToTopDraft,
          edges: [{
            ...bottomToTopDraft.edges[0],
            source_port: 'left',
            target_port: 'bottom',
          }],
        }}
        identity="team-ports"
        mode="library"
      />,
    )

    await waitFor(() => expect(JSON.parse(canvas.dataset.portUsage)).toEqual({
      lead: { left: { incoming: 0, outgoing: 1 } },
      writer: { bottom: { incoming: 1, outgoing: 0 } },
    }))
    expect(JSON.parse(canvas.dataset.edgeHandles)).toEqual([{
      id: 'lead::writer',
      sourceHandle: 'left',
      targetHandle: 'bottom',
    }])
  })
})
