export const TEAM_PORTS = ['top', 'right', 'bottom', 'left']

const PORT_NORMALS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

export function normalizeTeamPort(port, fallback) {
  return TEAM_PORTS.includes(port) ? port : fallback
}

export function getTeamPortConstraint(sourcePort, targetPort) {
  const normalizedSourcePort = normalizeTeamPort(sourcePort, 'right')
  const normalizedTargetPort = normalizeTeamPort(targetPort, 'left')
  const sourceNormal = PORT_NORMALS[normalizedSourcePort]
  const targetNormal = PORT_NORMALS[normalizedTargetPort]
  let x = sourceNormal.x - targetNormal.x
  let y = sourceNormal.y - targetNormal.y
  const sameSide = x === 0 && y === 0

  // Equal-facing ports cannot both point directly at one another. Give them a
  // stable tangent instead: left/right pairs stack vertically while top/bottom
  // pairs spread horizontally, leaving the shared outer side clear for a curve.
  if (sameSide) {
    if (normalizedSourcePort === 'left' || normalizedSourcePort === 'right') {
      x = 0
      y = 1
    } else {
      x = 1
      y = 0
    }
  }

  const magnitude = Math.hypot(x, y)
  const dot = (sourceNormal.x * targetNormal.x) + (sourceNormal.y * targetNormal.y)
  const kind = sameSide ? 'same-side' : dot === -1 ? 'opposite' : 'adjacent'

  return {
    direction: { x: x / magnitude, y: y / magnitude },
    kind,
    sourceNormal,
    sourcePort: normalizedSourcePort,
    strength: kind === 'opposite' ? 1 : kind === 'adjacent' ? 0.82 : 0.58,
    targetNormal,
    targetPort: normalizedTargetPort,
    // Siblings leaving the same source port fan across this axis. Its sign is
    // stable so the same graph always derives the same anchors.
    fanAxis: { x: -sourceNormal.y, y: sourceNormal.x },
  }
}
