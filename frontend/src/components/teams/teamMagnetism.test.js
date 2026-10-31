import { describe, expect, it } from 'vitest'
import { stepTeamMagnetism } from './teamMagnetism'

function node(id, x, y = 0, anchor = { x, y }) {
  return { data: { anchor }, id, position: { x, y } }
}

describe('Team canvas magnetism', () => {
  it('repels circular nodes before they visually overlap', () => {
    const result = stepTeamMagnetism({
      delta: 1,
      nodes: [node('left', 0), node('right', 80)],
    })

    expect(result.nodes[0].position.x).toBeLessThan(0)
    expect(result.nodes[1].position.x).toBeGreaterThan(80)
  })

  it('pulls connected Agents toward a useful delegation distance', () => {
    const result = stepTeamMagnetism({
      delta: 1,
      edges: [{ source: 'source', target: 'target' }],
      nodes: [node('source', 0), node('target', 440)],
    })

    expect(result.nodes[0].position.x).toBeGreaterThan(0)
    expect(result.nodes[1].position.x).toBeLessThan(440)
  })

  it('pulls an Agent toward the lane derived from the DAG topology', () => {
    const result = stepTeamMagnetism({
      delta: 1,
      nodes: [node('agent', 420, 40, { x: 120, y: 320 })],
    })

    expect(result.nodes[0].position.x).toBeLessThan(420)
    expect(result.nodes[0].position.y).toBeGreaterThan(40)
  })

  it('pushes a target toward the right when it drifts behind its caller', () => {
    const result = stepTeamMagnetism({
      delta: 1,
      edges: [{ source: 'source', target: 'target' }],
      nodes: [node('source', 200), node('target', 0)],
    })

    expect(result.nodes[0].position.x).toBeLessThan(200)
    expect(result.nodes[1].position.x).toBeGreaterThan(0)
  })

  it('pushes a bottom-to-top target below its caller', () => {
    const result = stepTeamMagnetism({
      delta: 1,
      edges: [{ source: 'source', sourcePort: 'bottom', target: 'target', targetPort: 'top' }],
      nodes: [node('source', 0, 0), node('target', 0, -200)],
    })

    expect(result.nodes[0].position.y).toBeLessThan(0)
    expect(result.nodes[1].position.y).toBeGreaterThan(-200)
  })

  it('vertically staggers a same-side right-to-right connection', () => {
    const result = stepTeamMagnetism({
      delta: 1,
      edges: [{ source: 'source', sourcePort: 'right', target: 'target', targetPort: 'right' }],
      nodes: [node('source', 0, 0), node('target', 200, 0)],
    })

    expect(result.nodes[0].position.y).toBeLessThan(0)
    expect(result.nodes[1].position.y).toBeGreaterThan(0)
  })

  it('never moves the Agent currently controlled by the user', () => {
    const dragged = node('dragged', 0)
    const result = stepTeamMagnetism({
      delta: 1,
      draggingIds: new Set(['dragged']),
      nodes: [dragged, node('neighbor', 70)],
    })

    expect(result.nodes[0]).toBe(dragged)
    expect(result.nodes[1].position.x).toBeGreaterThan(70)
  })
})
