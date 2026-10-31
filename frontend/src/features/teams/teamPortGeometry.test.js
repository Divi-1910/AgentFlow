import { describe, expect, it } from 'vitest'
import { getTeamPortConstraint, TEAM_PORTS } from './teamPortGeometry'

describe('Team port geometry', () => {
  it.each([
    ['top', 'top', 1, 0, 'same-side'],
    ['top', 'right', -1, -1, 'adjacent'],
    ['top', 'bottom', 0, -1, 'opposite'],
    ['top', 'left', 1, -1, 'adjacent'],
    ['right', 'top', 1, 1, 'adjacent'],
    ['right', 'right', 0, 1, 'same-side'],
    ['right', 'bottom', 1, -1, 'adjacent'],
    ['right', 'left', 1, 0, 'opposite'],
    ['bottom', 'top', 0, 1, 'opposite'],
    ['bottom', 'right', -1, 1, 'adjacent'],
    ['bottom', 'bottom', 1, 0, 'same-side'],
    ['bottom', 'left', 1, 1, 'adjacent'],
    ['left', 'top', -1, 1, 'adjacent'],
    ['left', 'right', -1, 0, 'opposite'],
    ['left', 'bottom', -1, -1, 'adjacent'],
    ['left', 'left', 0, 1, 'same-side'],
  ])('%s → %s derives a stable readable direction', (sourcePort, targetPort, expectedX, expectedY, kind) => {
    const constraint = getTeamPortConstraint(sourcePort, targetPort)

    expect(Math.sign(constraint.direction.x)).toBe(Math.sign(expectedX))
    expect(Math.sign(constraint.direction.y)).toBe(Math.sign(expectedY))
    expect(constraint.kind).toBe(kind)
    expect(Math.hypot(constraint.direction.x, constraint.direction.y)).toBeCloseTo(1)
  })

  it('covers every supported source and target combination', () => {
    const combinations = TEAM_PORTS.flatMap((sourcePort) => (
      TEAM_PORTS.map((targetPort) => getTeamPortConstraint(sourcePort, targetPort))
    ))

    expect(combinations).toHaveLength(16)
    expect(combinations.every(({ direction }) => Number.isFinite(direction.x) && Number.isFinite(direction.y))).toBe(true)
  })
})
