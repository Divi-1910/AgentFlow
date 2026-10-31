import { describe, expect, it } from 'vitest'
import {
  nextBottomFollowPosition,
  nextStreamingRevealCount,
  segmentGraphemes,
  streamingRevealDelay,
} from './streamPresentation'

describe('stream presentation pacing', () => {
  it('reveals a provider burst progressively without changing its order', () => {
    const target = segmentGraphemes('AgentFlow streams the complete response.')
    let visibleCount = 0
    const snapshots = []

    while (visibleCount < target.length) {
      visibleCount = nextStreamingRevealCount(visibleCount, target)
      snapshots.push(target.slice(0, visibleCount).join(''))
    }

    expect(snapshots.length).toBeGreaterThan(1)
    expect(snapshots.at(-1)).toBe(target.join(''))
    expect(snapshots.every((snapshot) => target.join('').startsWith(snapshot))).toBe(true)
  })

  it('releases small provider deltas as intact bursts', () => {
    const target = segmentGraphemes('Agent')

    expect(nextStreamingRevealCount(0, target)).toBe(target.length)
  })

  it('prefers a nearby natural boundary for buffered text', () => {
    const target = segmentGraphemes('AgentFlow streams in calm, readable fragments.')
    const firstCount = nextStreamingRevealCount(0, target)

    expect(target.slice(0, firstCount).join('')).toBe('AgentFlow ')
  })

  it('accelerates smoothly when unread text accumulates', () => {
    const smallBacklogDelay = streamingRevealDelay(4)
    const mediumBacklogDelay = streamingRevealDelay(64)
    const largeBacklogDelay = streamingRevealDelay(2000)

    expect(smallBacklogDelay).toBeGreaterThan(mediumBacklogDelay)
    expect(mediumBacklogDelay).toBeGreaterThan(largeBacklogDelay)
    expect(streamingRevealDelay(64, { terminal: true })).toBeLessThan(mediumBacklogDelay)
    expect(streamingRevealDelay(2000, { terminal: true })).toBe(largeBacklogDelay)
  })

  it('keeps completion catch-up bounded to a short fragment', () => {
    const target = Array.from({ length: 5000 }, () => 'a')

    expect(nextStreamingRevealCount(0, target, { terminal: true })).toBe(18)
  })

  it('never separates a composed emoji into invalid visual fragments', () => {
    const family = '👨‍👩‍👧‍👦'
    const segments = segmentGraphemes(`Hello ${family}!`)

    expect(segments).toContain(family)
    expect(segments.join('')).toBe(`Hello ${family}!`)
  })

  it('softly follows the bottom without jumping the full distance', () => {
    expect(nextBottomFollowPosition(100, 500)).toBe(196)
  })

  it('settles at the bottom without overshooting', () => {
    expect(nextBottomFollowPosition(499.5, 500)).toBe(500)
    expect(nextBottomFollowPosition(510, 500)).toBe(507.6)
  })
})
