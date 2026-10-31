import { getTeamPortConstraint, normalizeTeamPort } from './teamPortGeometry'

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NODES = 50
const MAX_EDGES = 100
const MAX_DEPTH = 5
const MAX_COORDINATE = 1_000_000
const LAYOUT_EDGE_DISTANCE = 250
const LAYOUT_FAN_GAP = 142
const LAYOUT_COLLISION_DISTANCE = 156

export { TEAM_PORTS, normalizeTeamPort } from './teamPortGeometry'

export function normalizeTeamConnection(connection) {
  return {
    sourceAgentId: connection.source,
    sourcePort: normalizeTeamPort(connection.sourceHandle, 'right'),
    targetAgentId: connection.target,
    targetPort: normalizeTeamPort(connection.targetHandle, 'left'),
  }
}

function normalizeEdge(edge) {
  return {
    description: edge.description || '',
    instructions: edge.instructions || '',
    source_agent_id: edge.source_agent_id,
    source_port: normalizeTeamPort(edge.source_port, 'right'),
    target_agent_id: edge.target_agent_id,
    target_port: normalizeTeamPort(edge.target_port, 'left'),
    tool_name: edge.tool_name || '',
  }
}

export function createEmptyTeamDraft() {
  return {
    description: '',
    edges: [],
    entry_agent_id: '',
    name: '',
    nodes: [],
  }
}

export function teamToDraft(team) {
  if (!team) return createEmptyTeamDraft()
  return {
    description: team.description || '',
    edges: (team.edges || []).map(normalizeEdge),
    entry_agent_id: team.entry_agent_id || '',
    name: team.name || '',
    nodes: (team.nodes || []).map((node) => ({
      agent_id: node.agent_id,
      position: {
        x: Number(node.position?.x) || 0,
        y: Number(node.position?.y) || 0,
      },
    })),
  }
}

export function normalizeTeamDraft(draft) {
  return {
    description: draft.description || '',
    edges: (draft.edges || []).map(normalizeEdge),
    entry_agent_id: draft.entry_agent_id || '',
    name: draft.name || '',
    nodes: (draft.nodes || []).map((node) => ({
      agent_id: node.agent_id,
      position: {
        x: Number(node.position?.x) || 0,
        y: Number(node.position?.y) || 0,
      },
    })),
  }
}

export function teamDraftEquals(left, right) {
  return JSON.stringify(normalizeTeamDraft(left)) === JSON.stringify(normalizeTeamDraft(right))
}

export function buildTeamCreatePayload(draft) {
  const normalized = normalizeTeamDraft(draft)
  return {
    ...normalized,
    description: normalized.description.trim(),
    edges: normalized.edges.map(trimEdge),
    entry_agent_id: normalized.entry_agent_id.trim(),
    name: normalized.name.trim(),
  }
}

export function buildTeamPatch(draft, baseline) {
  const next = buildTeamCreatePayload(draft)
  const previous = buildTeamCreatePayload(baseline || createEmptyTeamDraft())
  const patch = {}

  if (next.name !== previous.name) patch.name = next.name
  if (next.description !== previous.description) patch.description = next.description

  const graphKeys = ['entry_agent_id', 'nodes', 'edges']
  const graphChanged = graphKeys.some((key) => JSON.stringify(next[key]) !== JSON.stringify(previous[key]))
  if (graphChanged) {
    patch.entry_agent_id = next.entry_agent_id
    patch.nodes = next.nodes
    patch.edges = next.edges
  }
  return patch
}

function trimEdge(edge) {
  return {
    description: edge.description.trim(),
    instructions: edge.instructions.trim(),
    source_agent_id: edge.source_agent_id.trim(),
    source_port: normalizeTeamPort(edge.source_port, 'right'),
    target_agent_id: edge.target_agent_id.trim(),
    target_port: normalizeTeamPort(edge.target_port, 'left'),
    tool_name: edge.tool_name.trim(),
  }
}

export function delegationId(sourceAgentId, targetAgentId) {
  return `${sourceAgentId}::${targetAgentId}`
}

export function getTeamConnectionError(draft, sourceAgentId, targetAgentId) {
  const nodes = draft.nodes || []
  const edges = draft.edges || []
  const nodeIds = new Set(nodes.map((node) => node.agent_id))

  if (!sourceAgentId || !targetAgentId) return 'Choose both a caller and a callable Agent.'
  if (!nodeIds.has(sourceAgentId) || !nodeIds.has(targetAgentId)) return 'Both ends must be Agents in this Team.'
  if (sourceAgentId === targetAgentId) return 'An Agent cannot delegate work to itself.'
  if (edges.length >= MAX_EDGES) return `A Team can contain at most ${MAX_EDGES} delegations.`
  if (edges.some((edge) => edge.source_agent_id === sourceAgentId && edge.target_agent_id === targetAgentId)) {
    return 'This caller can already delegate to that Agent.'
  }

  const adjacency = new Map(nodes.map((node) => [node.agent_id, []]))
  for (const edge of edges) {
    if (adjacency.has(edge.source_agent_id) && nodeIds.has(edge.target_agent_id)) {
      adjacency.get(edge.source_agent_id).push(edge.target_agent_id)
    }
  }

  // Adding source -> target creates a cycle exactly when target can already
  // reach source. Checking this before mutation keeps the editor a DAG at all
  // times instead of allowing an invalid draft that can only fail on save.
  const pending = [targetAgentId]
  const visited = new Set()
  while (pending.length > 0) {
    const agentId = pending.pop()
    if (agentId === sourceAgentId) return 'That delegation would create a cycle.'
    if (visited.has(agentId)) continue
    visited.add(agentId)
    pending.push(...(adjacency.get(agentId) || []))
  }

  adjacency.get(sourceAgentId).push(targetAgentId)
  if (draft.entry_agent_id && nodeIds.has(draft.entry_agent_id)) {
    const memo = new Map()
    const visiting = new Set()
    let containsExistingCycle = false

    function longestPathFrom(agentId) {
      if (visiting.has(agentId)) {
        containsExistingCycle = true
        return 0
      }
      if (memo.has(agentId)) return memo.get(agentId)
      visiting.add(agentId)
      let depth = 0
      for (const targetId of adjacency.get(agentId) || []) {
        depth = Math.max(depth, longestPathFrom(targetId) + 1)
      }
      visiting.delete(agentId)
      memo.set(agentId, depth)
      return depth
    }

    const depth = longestPathFrom(draft.entry_agent_id)
    if (containsExistingCycle) return 'Delegations must form a DAG before adding another route.'
    if (depth > MAX_DEPTH) return `A delegation path cannot be deeper than ${MAX_DEPTH} edges.`
  }

  return null
}

export function suggestedDelegationName(agent, existingNames = []) {
  const suffix = String(agent?.name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'agent'
  const base = `delegate_to_${suffix}`.slice(0, 64)
  const occupied = new Set(existingNames)
  if (!occupied.has(base)) return base

  let index = 2
  while (occupied.has(`${base.slice(0, 61)}_${index}`)) index += 1
  return `${base.slice(0, 61)}_${index}`.slice(0, 64)
}

export function defaultNodePosition(index) {
  const column = index % 4
  const row = Math.floor(index / 4)
  return { x: 120 + (column * 220), y: 150 + (row * 140) }
}

export function layoutTeamGraph(draft) {
  const nodes = draft.nodes || []
  if (nodes.length < 2) return draft

  const nodeIds = new Set(nodes.map((node) => node.agent_id))
  const order = new Map(nodes.map((node, index) => [node.agent_id, index]))
  const outgoing = new Map(nodes.map((node) => [node.agent_id, []]))
  const indegree = new Map(nodes.map((node) => [node.agent_id, 0]))

  for (const edge of draft.edges || []) {
    if (!nodeIds.has(edge.source_agent_id) || !nodeIds.has(edge.target_agent_id)) continue
    outgoing.get(edge.source_agent_id).push(edge)
    indegree.set(edge.target_agent_id, indegree.get(edge.target_agent_id) + 1)
  }

  const compareNodeIds = (left, right) => {
    if (left === draft.entry_agent_id) return -1
    if (right === draft.entry_agent_id) return 1
    return order.get(left) - order.get(right)
  }
  const queue = nodes
    .filter((node) => indegree.get(node.agent_id) === 0)
    .map((node) => node.agent_id)
    .sort(compareNodeIds)
  const visited = new Set()
  const topologicalOrder = []

  while (queue.length > 0) {
    const sourceId = queue.shift()
    visited.add(sourceId)
    topologicalOrder.push(sourceId)
    for (const edge of outgoing.get(sourceId) || []) {
      const targetId = edge.target_agent_id
      indegree.set(targetId, indegree.get(targetId) - 1)
      if (indegree.get(targetId) === 0) queue.push(targetId)
    }
    queue.sort(compareNodeIds)
  }

  const positions = new Map()
  const proposals = new Map(nodes.map((node) => [node.agent_id, []]))
  const entryOrigin = { x: 120, y: 320 }

  // Saved coordinates are deliberately excluded. The same topology and ports
  // must derive the same anchors regardless of where a node was last dragged.
  for (const agentId of topologicalOrder) {
    const incomingProposals = proposals.get(agentId)
    if (incomingProposals.length > 0) {
      positions.set(agentId, {
        x: incomingProposals.reduce((sum, point) => sum + point.x, 0) / incomingProposals.length,
        y: incomingProposals.reduce((sum, point) => sum + point.y, 0) / incomingProposals.length,
      })
    } else if (agentId === draft.entry_agent_id) {
      positions.set(agentId, entryOrigin)
    } else {
      const rootIndex = order.get(agentId)
      positions.set(agentId, { x: entryOrigin.x, y: entryOrigin.y + ((rootIndex + 1) * LAYOUT_FAN_GAP) })
    }

    const sourcePosition = positions.get(agentId)
    const groups = new Map()
    for (const edge of outgoing.get(agentId) || []) {
      const constraint = getTeamPortConstraint(edge.source_port, edge.target_port)
      const siblings = groups.get(constraint.sourcePort) || []
      siblings.push({ constraint, edge })
      groups.set(constraint.sourcePort, siblings)
    }

    for (const siblings of groups.values()) {
      siblings.sort((left, right) => order.get(left.edge.target_agent_id) - order.get(right.edge.target_agent_id))
      siblings.forEach(({ constraint, edge }, index) => {
        const fanOffset = (index - ((siblings.length - 1) / 2)) * LAYOUT_FAN_GAP
        proposals.get(edge.target_agent_id)?.push({
          x: sourcePosition.x + (constraint.direction.x * LAYOUT_EDGE_DISTANCE) + (constraint.fanAxis.x * fanOffset),
          y: sourcePosition.y + (constraint.direction.y * LAYOUT_EDGE_DISTANCE) + (constraint.fanAxis.y * fanOffset),
        })
      })
    }
  }

  // Invalid cyclic or disconnected drafts cannot be fully topologically
  // positioned. Keep them visible in a deterministic repair area.
  let repairIndex = 0
  for (const node of nodes) {
    if (visited.has(node.agent_id)) continue
    positions.set(node.agent_id, {
      x: entryOrigin.x + LAYOUT_EDGE_DISTANCE,
      y: entryOrigin.y + ((repairIndex + 1) * LAYOUT_FAN_GAP),
    })
    repairIndex += 1
  }

  // Resolve anchor collisions deterministically. This is deliberately bounded:
  // the live magnetic field performs the final soft settle after topology edits.
  for (let pass = 0; pass < 12; pass += 1) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const leftId = nodes[leftIndex].agent_id
        const rightId = nodes[rightIndex].agent_id
        const left = positions.get(leftId)
        const right = positions.get(rightId)
        let deltaX = right.x - left.x
        let deltaY = right.y - left.y
        let distance = Math.hypot(deltaX, deltaY)
        if (distance >= LAYOUT_COLLISION_DISTANCE) continue
        if (distance < 0.01) {
          deltaX = leftId.localeCompare(rightId) <= 0 ? 1 : -1
          deltaY = 0
          distance = 1
        }
        const overlap = LAYOUT_COLLISION_DISTANCE - distance
        const pushX = (deltaX / distance) * overlap
        const pushY = (deltaY / distance) * overlap
        if (leftId === draft.entry_agent_id) {
          right.x += pushX
          right.y += pushY
        } else if (rightId === draft.entry_agent_id) {
          left.x -= pushX
          left.y -= pushY
        } else {
          left.x -= pushX / 2
          left.y -= pushY / 2
          right.x += pushX / 2
          right.y += pushY / 2
        }
      }
    }
  }

  return {
    ...draft,
    nodes: nodes.map((node) => {
      const position = positions.get(node.agent_id) || node.position
      return {
        ...node,
        position: {
          x: Math.round(position.x * 100) / 100,
          y: Math.round(position.y * 100) / 100,
        },
      }
    }),
  }
}

export function getTeamFocusPath(draft, selection) {
  if (!selection?.id || selection.type === 'team') return null

  const edges = draft.edges || []
  const incoming = new Map()
  const outgoing = new Map()
  for (const node of draft.nodes || []) {
    incoming.set(node.agent_id, [])
    outgoing.set(node.agent_id, [])
  }
  for (const edge of edges) {
    incoming.get(edge.target_agent_id)?.push(edge)
    outgoing.get(edge.source_agent_id)?.push(edge)
  }

  const focusedNodeIds = new Set()
  const focusedEdgeIds = new Set()
  const visited = new Set()
  const walk = (agentId, direction) => {
    const visitKey = `${direction}:${agentId}`
    if (visited.has(visitKey)) return
    visited.add(visitKey)
    focusedNodeIds.add(agentId)
    const routes = direction === 'incoming' ? incoming.get(agentId) : outgoing.get(agentId)
    for (const edge of routes || []) {
      focusedEdgeIds.add(delegationId(edge.source_agent_id, edge.target_agent_id))
      walk(direction === 'incoming' ? edge.source_agent_id : edge.target_agent_id, direction)
    }
  }

  if (selection.type === 'node') {
    walk(selection.id, 'incoming')
    walk(selection.id, 'outgoing')
  }
  if (selection.type === 'edge') {
    const selectedEdge = edges.find((edge) => delegationId(edge.source_agent_id, edge.target_agent_id) === selection.id)
    if (selectedEdge) {
      focusedEdgeIds.add(selection.id)
      walk(selectedEdge.source_agent_id, 'incoming')
      walk(selectedEdge.target_agent_id, 'outgoing')
    }
  }

  return {
    edgeIds: focusedEdgeIds,
    nodeIds: focusedNodeIds,
  }
}

export function describeTeamExecution(draft, agents = []) {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const entryAgent = agentsById.get(draft.entry_agent_id)
  const routes = (draft.edges || []).map((edge) => ({
    condition: edge.description || '',
    id: delegationId(edge.source_agent_id, edge.target_agent_id),
    instructions: edge.instructions || '',
    source: agentsById.get(edge.source_agent_id),
    sourceAgentId: edge.source_agent_id,
    target: agentsById.get(edge.target_agent_id),
    targetAgentId: edge.target_agent_id,
  }))

  if (!entryAgent) {
    return {
      entryAgent: null,
      intro: 'Choose the Agent that will receive every new request.',
      note: 'The entry Agent is the only Agent that hears from the user directly.',
      routes,
    }
  }

  if (routes.length === 0) {
    return {
      entryAgent,
      intro: `Every request starts with ${entryAgent.name}.`,
      note: draft.nodes.length === 1
        ? `There are no delegation routes, so this Team currently behaves like ${entryAgent.name} under a separate Team identity.`
        : 'The other Agents cannot be reached until you add delegation routes from the entry Agent.',
      routes,
    }
  }

  return {
    entryAgent,
    intro: `Every request starts with ${entryAgent.name}.`,
    note: 'These routes are available choices, not guaranteed steps. Each Agent decides at runtime whether it needs to delegate.',
    routes,
  }
}

export function validateTeamDraft(draft, { agents = [], tools = [] } = {}) {
  const errors = {}
  const edgeErrors = {}
  const normalized = buildTeamCreatePayload(draft)
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const catalogTools = new Set(tools.map((tool) => tool.name))
  const nodeIds = new Set()

  if (!normalized.name) errors.name = 'Give this team a name.'
  if (normalized.nodes.length === 0) errors.graph = 'Add at least one agent to the team.'
  if (normalized.nodes.length > MAX_NODES) errors.graph = `A team can contain at most ${MAX_NODES} agents.`
  if (normalized.edges.length > MAX_EDGES) errors.graph = `A team can contain at most ${MAX_EDGES} delegations.`

  normalized.nodes.forEach((node) => {
    if (!node.agent_id || nodeIds.has(node.agent_id)) errors.graph = 'Each agent can appear only once in a team.'
    nodeIds.add(node.agent_id)
    if (!agentsById.has(node.agent_id)) errors.graph = 'Every node must reference one of your standalone agents.'
    const coordinates = [node.position.x, node.position.y]
    if (coordinates.some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)) {
      errors.graph = 'Agent positions are outside the supported canvas range.'
    }
  })

  if (!normalized.entry_agent_id) errors.entry_agent_id = 'Choose the agent that receives the first request.'
  else if (!nodeIds.has(normalized.entry_agent_id)) errors.entry_agent_id = 'The entry agent must be part of the team.'

  const adjacency = new Map([...nodeIds].map((id) => [id, []]))
  const pairs = new Set()
  const outgoingNames = new Map()

  normalized.edges.forEach((edge) => {
    const id = delegationId(edge.source_agent_id, edge.target_agent_id)
    const messages = []
    if (!nodeIds.has(edge.source_agent_id) || !nodeIds.has(edge.target_agent_id)) messages.push('Both ends must be agents in this team.')
    if (edge.source_agent_id === edge.target_agent_id) messages.push('An agent cannot delegate to itself.')
    if (pairs.has(id)) messages.push('Only one delegation is allowed between the same two agents.')
    pairs.add(id)
    if (!TOOL_NAME_PATTERN.test(edge.tool_name)) messages.push('Use 1–64 letters, numbers, underscores, or hyphens.')
    if (!edge.description) messages.push('Describe when this delegation should be used.')

    const names = outgoingNames.get(edge.source_agent_id) || new Set()
    if (names.has(edge.tool_name)) messages.push('Outgoing delegation names must be unique for this agent.')
    const sourceTools = new Set(agentsById.get(edge.source_agent_id)?.tools || [])
    if (sourceTools.has(edge.tool_name) || catalogTools.has(edge.tool_name)) {
      messages.push('This name collides with a tool available to the source agent.')
    }
    names.add(edge.tool_name)
    outgoingNames.set(edge.source_agent_id, names)
    if (adjacency.has(edge.source_agent_id) && nodeIds.has(edge.target_agent_id)) {
      adjacency.get(edge.source_agent_id).push(edge.target_agent_id)
    }
    if (messages.length > 0) edgeErrors[id] = messages.join(' ')
  })

  if (normalized.entry_agent_id && nodeIds.has(normalized.entry_agent_id)) {
    const state = new Map()
    const longestFrom = new Map()
    let hasCycle = false

    function visit(agentId) {
      if (state.get(agentId) === 1) {
        hasCycle = true
        return 0
      }
      if (state.get(agentId) === 2) return longestFrom.get(agentId)
      state.set(agentId, 1)
      let depth = 0
      for (const targetId of adjacency.get(agentId) || []) {
        depth = Math.max(depth, visit(targetId) + 1)
      }
      state.set(agentId, 2)
      longestFrom.set(agentId, depth)
      return depth
    }

    const longestDepth = visit(normalized.entry_agent_id)
    if (hasCycle) errors.graph = 'Delegations must form a DAG; remove the cycle before saving.'
    else if (state.size !== nodeIds.size) errors.graph = 'Every agent must be reachable from the entry agent.'
    else if (longestDepth > MAX_DEPTH) errors.graph = `A delegation path cannot be deeper than ${MAX_DEPTH} edges.`
  }

  return {
    edgeErrors,
    errors,
    valid: Object.keys(errors).length === 0 && Object.keys(edgeErrors).length === 0,
  }
}
