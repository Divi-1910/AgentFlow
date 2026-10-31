import { describe, expect, it } from 'vitest'
import {
  buildTeamCreatePayload,
  buildTeamPatch,
  createEmptyTeamDraft,
  describeTeamExecution,
  getTeamConnectionError,
  getTeamFocusPath,
  layoutTeamGraph,
  normalizeTeamConnection,
  validateTeamDraft,
} from './teamGraph'

const agents = [
  { id: 'lead', name: 'Lead', tools: ['web_search'] },
  { id: 'writer', name: 'Writer', tools: [] },
  { id: 'reviewer', name: 'Reviewer', tools: [] },
]

function validDraft() {
  return {
    description: 'Coordinates research.',
    entry_agent_id: 'lead',
    name: 'Research team',
    nodes: [
      { agent_id: 'lead', position: { x: 10, y: 20 } },
      { agent_id: 'writer', position: { x: 320, y: 20 } },
    ],
    edges: [{
      description: 'Write the report.',
      instructions: '',
      source_agent_id: 'lead',
      source_port: 'right',
      target_agent_id: 'writer',
      target_port: 'left',
      tool_name: 'delegate_to_writer',
    }],
  }
}

describe('team graph contract', () => {
  it('builds the backend creation contract and trims human-entered fields', () => {
    const draft = validDraft()
    draft.name = ' Research team '
    draft.edges[0].description = ' Write the report. '

    expect(buildTeamCreatePayload(draft)).toEqual({
      ...validDraft(),
      edges: [{ ...validDraft().edges[0], description: 'Write the report.' }],
    })
  })

  it('defaults legacy edge attachment sides without changing delegation direction', () => {
    const draft = validDraft()
    delete draft.edges[0].source_port
    delete draft.edges[0].target_port

    const payload = buildTeamCreatePayload(draft)

    expect(payload.edges[0]).toMatchObject({
      source_agent_id: 'lead',
      source_port: 'right',
      target_agent_id: 'writer',
      target_port: 'left',
    })
  })

  it('preserves pointer origin as caller regardless of the chosen port sides', () => {
    expect(normalizeTeamConnection({
      source: 'writer',
      sourceHandle: 'top',
      target: 'lead',
      targetHandle: 'bottom',
    })).toEqual({
      sourceAgentId: 'writer',
      sourcePort: 'top',
      targetAgentId: 'lead',
      targetPort: 'bottom',
    })
  })

  it('sends the complete graph whenever any topology field changes', () => {
    const baseline = validDraft()
    const draft = validDraft()
    draft.nodes[1].position.x = 640

    expect(buildTeamPatch(draft, baseline)).toEqual({
      edges: draft.edges,
      entry_agent_id: 'lead',
      nodes: draft.nodes,
    })
  })

  it('accepts a reachable acyclic delegation graph', () => {
    expect(validateTeamDraft(validDraft(), { agents, tools: [{ name: 'calculator' }] }))
      .toEqual({ edgeErrors: {}, errors: {}, valid: true })
  })

  it('rejects delegation cycles', () => {
    const draft = validDraft()
    draft.edges.push({
      description: 'Return to the lead.',
      instructions: '',
      source_agent_id: 'writer',
      source_port: 'bottom',
      target_agent_id: 'lead',
      target_port: 'top',
      tool_name: 'delegate_to_lead',
    })

    expect(validateTeamDraft(draft, { agents }).errors.graph).toContain('DAG')
  })

  it('preserves caller-to-callee meaning when admitting a new connection', () => {
    const draft = validDraft()
    draft.nodes.push({ agent_id: 'reviewer', position: { x: 640, y: 20 } })

    expect(getTeamConnectionError(draft, 'writer', 'reviewer')).toBeNull()
    expect(getTeamConnectionError(draft, 'writer', 'writer')).toContain('itself')
    expect(getTeamConnectionError(draft, 'lead', 'writer')).toContain('already')
    expect(getTeamConnectionError(draft, 'writer', 'lead')).toContain('cycle')
  })

  it('rejects a connection that would exceed the runtime delegation depth', () => {
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      agent_id: `agent-${index}`,
      position: { x: index * 250, y: 0 },
    }))
    const edges = Array.from({ length: 5 }, (_, index) => ({
      description: `Delegate to agent ${index + 1}.`,
      instructions: '',
      source_agent_id: `agent-${index}`,
      source_port: 'right',
      target_agent_id: `agent-${index + 1}`,
      target_port: 'left',
      tool_name: `delegate_to_agent_${index + 1}`,
    }))

    expect(getTeamConnectionError({ edges, entry_agent_id: 'agent-0', nodes }, 'agent-5', 'agent-6'))
      .toContain('deeper than 5')
  })

  it('rejects unreachable nodes and tool-name collisions', () => {
    const draft = validDraft()
    draft.nodes.push({ agent_id: 'reviewer', position: { x: 640, y: 20 } })
    draft.edges[0].tool_name = 'web_search'
    const result = validateTeamDraft(draft, { agents, tools: [{ name: 'calculator' }] })

    expect(result.errors.graph).toContain('reachable')
    expect(result.edgeErrors['lead::writer']).toContain('collides')
  })

  it('reports the required starting state without inventing a graph', () => {
    expect(validateTeamDraft(createEmptyTeamDraft(), { agents }).errors).toMatchObject({
      entry_agent_id: expect.any(String),
      graph: expect.any(String),
      name: expect.any(String),
    })
  })

  it('explains a delegation graph in runtime terms', () => {
    const summary = describeTeamExecution(validDraft(), agents)

    expect(summary.intro).toBe('Every request starts with Lead.')
    expect(summary.routes).toEqual([
      expect.objectContaining({
        condition: 'Write the report.',
        source: expect.objectContaining({ name: 'Lead' }),
        target: expect.objectContaining({ name: 'Writer' }),
      }),
    ])
    expect(summary.note).toContain('available choices, not guaranteed steps')
  })

  it('makes the one-Agent Team limitation explicit', () => {
    const draft = {
      description: '',
      edges: [],
      entry_agent_id: 'lead',
      name: 'Solo team',
      nodes: [{ agent_id: 'lead', position: { x: 0, y: 0 } }],
    }

    expect(describeTeamExecution(draft, agents).note).toContain('currently behaves like Lead')
  })

  it('lays out a DAG from entry to delegated Agents without changing its contract', () => {
    const draft = validDraft()
    draft.nodes.push({ agent_id: 'reviewer', position: { x: 20, y: 700 } })
    draft.edges.push({
      description: 'Review the report.',
      instructions: '',
      source_agent_id: 'writer',
      source_port: 'right',
      target_agent_id: 'reviewer',
      target_port: 'left',
      tool_name: 'delegate_to_reviewer',
    })

    const arranged = layoutTeamGraph(draft)
    const positions = new Map(arranged.nodes.map((node) => [node.agent_id, node.position]))

    expect(positions.get('lead').x).toBeLessThan(positions.get('writer').x)
    expect(positions.get('writer').x).toBeLessThan(positions.get('reviewer').x)
    expect(arranged.edges).toEqual(draft.edges)
  })

  it('derives stable DAG lanes independently of previously saved coordinates', () => {
    const first = validDraft()
    const second = {
      ...first,
      nodes: first.nodes.map((node, index) => ({
        ...node,
        position: { x: 900 - (index * 300), y: -500 + (index * 800) },
      })),
    }

    expect(layoutTeamGraph(first).nodes.map((node) => node.position))
      .toEqual(layoutTeamGraph(second).nodes.map((node) => node.position))
  })

  it('derives vertical anchors for a bottom-to-top delegation', () => {
    const draft = validDraft()
    draft.edges[0].source_port = 'bottom'
    draft.edges[0].target_port = 'top'

    const positions = new Map(layoutTeamGraph(draft).nodes.map((node) => [node.agent_id, node.position]))

    expect(positions.get('writer').y).toBeGreaterThan(positions.get('lead').y)
  })

  it('uses a stable tangent for a same-side right-to-right delegation', () => {
    const draft = validDraft()
    draft.edges[0].source_port = 'right'
    draft.edges[0].target_port = 'right'

    const positions = new Map(layoutTeamGraph(draft).nodes.map((node) => [node.agent_id, node.position]))

    expect(positions.get('writer').y).toBeGreaterThan(positions.get('lead').y)
  })

  it('fans siblings sharing one source port instead of stacking them', () => {
    const draft = validDraft()
    draft.nodes.push({ agent_id: 'reviewer', position: { x: 0, y: 0 } })
    draft.edges.push({
      description: 'Review the report.',
      instructions: '',
      source_agent_id: 'lead',
      source_port: 'right',
      target_agent_id: 'reviewer',
      target_port: 'left',
      tool_name: 'delegate_to_reviewer',
    })

    const positions = new Map(layoutTeamGraph(draft).nodes.map((node) => [node.agent_id, node.position]))

    expect(positions.get('writer').x).toBeGreaterThan(positions.get('lead').x)
    expect(positions.get('reviewer').x).toBeGreaterThan(positions.get('lead').x)
    expect(Math.abs(positions.get('writer').y - positions.get('reviewer').y)).toBeGreaterThanOrEqual(140)
  })

  it('focuses the complete upstream and downstream path around a selected Agent', () => {
    const draft = validDraft()
    draft.nodes.push({ agent_id: 'reviewer', position: { x: 640, y: 20 } })
    draft.edges.push({
      description: 'Review the report.',
      instructions: '',
      source_agent_id: 'writer',
      source_port: 'right',
      target_agent_id: 'reviewer',
      target_port: 'left',
      tool_name: 'delegate_to_reviewer',
    })

    const focus = getTeamFocusPath(draft, { id: 'writer', type: 'node' })

    expect([...focus.nodeIds]).toEqual(expect.arrayContaining(['lead', 'writer', 'reviewer']))
    expect([...focus.edgeIds]).toEqual(expect.arrayContaining(['lead::writer', 'writer::reviewer']))
  })
})
