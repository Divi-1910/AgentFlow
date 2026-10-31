import { getTeamPortConstraint } from '../../features/teams/teamPortGeometry'

export const TEAM_NODE_DIAMETER = 112

const ANCHOR_PULL = 0.035
const COLLISION_DISTANCE = 148
const COLLISION_STRENGTH = 0.018
const CONNECTION_DISTANCE = 238
const CONNECTION_STRENGTH = 0.004
const DAMPING = 0.82
const MAX_FORCE = 0.7
const MAX_SPEED = 5.5
const MIN_DIRECTION_GAP = 158
const DIRECTION_STRENGTH = 0.006
const ALIGNMENT_STRENGTH = 0.00075

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

function nodeCenter(node) {
  return {
    x: node.position.x + (TEAM_NODE_DIAMETER / 2),
    y: node.position.y + (TEAM_NODE_DIAMETER / 2),
  }
}

export function stepTeamMagnetism({
  delta,
  draggingIds = new Set(),
  edges = [],
  nodes,
  velocities = new Map(),
}) {
  const nextVelocities = new Map(velocities)
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const forces = new Map(nodes.map((node) => {
    const anchor = node.data?.anchor || node.position
    return [node.id, {
      x: (anchor.x - node.position.x) * ANCHOR_PULL,
      y: (anchor.y - node.position.y) * ANCHOR_PULL,
    }]
  }))

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex]
      const right = nodes[rightIndex]
      const leftCenter = nodeCenter(left)
      const rightCenter = nodeCenter(right)
      let deltaX = rightCenter.x - leftCenter.x
      let deltaY = rightCenter.y - leftCenter.y
      let distance = Math.hypot(deltaX, deltaY)

      // Two nodes may be created at exactly the same coordinate. Use a stable
      // direction so they separate deterministically instead of producing NaN.
      if (distance < 0.01) {
        deltaX = left.id.localeCompare(right.id) <= 0 ? 1 : -1
        deltaY = 0
        distance = 1
      }
      if (distance >= COLLISION_DISTANCE) continue

      const strength = (COLLISION_DISTANCE - distance) * COLLISION_STRENGTH
      const forceX = (deltaX / distance) * strength
      const forceY = (deltaY / distance) * strength
      forces.get(left.id).x -= forceX
      forces.get(left.id).y -= forceY
      forces.get(right.id).x += forceX
      forces.get(right.id).y += forceY
    }
  }

  for (const edge of edges) {
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue

    const sourceCenter = nodeCenter(source)
    const targetCenter = nodeCenter(target)
    const deltaX = targetCenter.x - sourceCenter.x
    const deltaY = targetCenter.y - sourceCenter.y
    const distance = Math.max(Math.hypot(deltaX, deltaY), 1)
    const spring = clamp((distance - CONNECTION_DISTANCE) * CONNECTION_STRENGTH, -MAX_FORCE, MAX_FORCE)
    const springX = (deltaX / distance) * spring
    const springY = (deltaY / distance) * spring
    forces.get(source.id).x += springX
    forces.get(source.id).y += springY
    forces.get(target.id).x -= springX
    forces.get(target.id).y -= springY

    const constraint = getTeamPortConstraint(edge.sourcePort, edge.targetPort)
    const projection = (deltaX * constraint.direction.x) + (deltaY * constraint.direction.y)
    if (projection < MIN_DIRECTION_GAP) {
      const directionalForce = clamp(
        (MIN_DIRECTION_GAP - projection) * DIRECTION_STRENGTH * constraint.strength,
        0,
        MAX_FORCE,
      )
      const directionalX = constraint.direction.x * directionalForce
      const directionalY = constraint.direction.y * directionalForce
      forces.get(source.id).x -= directionalX
      forces.get(source.id).y -= directionalY
      forces.get(target.id).x += directionalX
      forces.get(target.id).y += directionalY
    }

    // Reduce sideways drift without forcing every edge onto a rigid line. The
    // deliberately weak force lets sibling fan-out, collision avoidance, and
    // multi-parent compromises remain more important than perfect alignment.
    const lateralX = deltaX - (constraint.direction.x * projection)
    const lateralY = deltaY - (constraint.direction.y * projection)
    const alignment = ALIGNMENT_STRENGTH * constraint.strength
    const alignmentX = clamp(lateralX * alignment, -MAX_FORCE, MAX_FORCE)
    const alignmentY = clamp(lateralY * alignment, -MAX_FORCE, MAX_FORCE)
    forces.get(source.id).x += alignmentX
    forces.get(source.id).y += alignmentY
    forces.get(target.id).x -= alignmentX
    forces.get(target.id).y -= alignmentY
  }

  let changed = false
  let energy = 0
  const nextNodes = nodes.map((node) => {
    if (draggingIds.has(node.id)) {
      nextVelocities.set(node.id, { x: 0, y: 0 })
      return node
    }

    const force = forces.get(node.id)
    const velocity = nextVelocities.get(node.id) || { x: 0, y: 0 }
    const damping = Math.pow(DAMPING, delta)
    const nextVelocity = {
      x: clamp((velocity.x + (force.x * delta)) * damping, -MAX_SPEED, MAX_SPEED),
      y: clamp((velocity.y + (force.y * delta)) * damping, -MAX_SPEED, MAX_SPEED),
    }
    nextVelocities.set(node.id, nextVelocity)

    const movementX = nextVelocity.x * delta
    const movementY = nextVelocity.y * delta
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

  return {
    changed,
    energy,
    nodes: changed ? nextNodes : nodes,
    velocities: nextVelocities,
  }
}
