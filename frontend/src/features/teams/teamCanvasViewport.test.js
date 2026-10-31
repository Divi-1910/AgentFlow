import { describe, expect, it } from 'vitest'
import {
  buildTeamCanvasFitPadding,
  calculateTeamCanvasMotionBounds,
  calculateTeamCanvasPanelInset,
  hasTeamCanvasInsets,
  isTeamCanvasBoundsVisible,
  normalizeTeamCanvasInsets,
  resolveTeamCanvasFitInsets,
  teamCanvasInsetsEqual,
} from './teamCanvasViewport'

describe('team canvas safe area', () => {
  it.each([
    ['left', 376],
    ['right', 396],
    ['top', 220],
    ['bottom', 232],
  ])('measures a %s panel as an intrusion from that canvas edge', (side, expected) => {
    expect(calculateTeamCanvasPanelInset({
      containerHeight: 800,
      containerWidth: 1200,
      gap: 16,
      panelHeight: side === 'bottom' ? 200 : 180,
      panelLeft: side === 'right' ? 820 : 20,
      panelTop: side === 'bottom' ? 584 : 24,
      panelWidth: 340,
      side,
    })).toBe(expected)
  })

  it('normalizes invalid measurements and compares semantic equality', () => {
    const normalized = normalizeTeamCanvasInsets({ bottom: Number.NaN, left: -20, right: 42.4, top: '18' })

    expect(normalized).toEqual({ bottom: 0, left: 0, right: 42, top: 18 })
    expect(hasTeamCanvasInsets(normalized)).toBe(true)
    expect(teamCanvasInsetsEqual(normalized, { bottom: 0, left: 0, right: 42, top: 18 })).toBe(true)
  })

  it('builds asymmetric pixel padding without double-counting base chrome', () => {
    expect(buildTeamCanvasFitPadding(
      { bottom: 0, left: 376, right: 0, top: 0 },
      { bottom: 30, left: 30, right: 30, top: 150 },
    )).toEqual({ bottom: '30px', left: '376px', right: '30px', top: '150px' })
  })

  it('builds a movement envelope from both current and magnetic target positions', () => {
    expect(calculateTeamCanvasMotionBounds([
      { data: { anchor: { x: 120, y: 320 } }, position: { x: 710, y: -180 } },
      { data: { anchor: { x: 120, y: 1030 } }, position: { x: 120, y: 290 } },
    ], 112)).toEqual({
      height: 1322,
      width: 702,
      x: 120,
      y: -180,
    })
  })

  it('checks graph visibility against the same safe area used for camera fitting', () => {
    expect(resolveTeamCanvasFitInsets({ left: 376 })).toEqual({
      bottom: 30,
      left: 376,
      right: 30,
      top: 150,
    })
    expect(isTeamCanvasBoundsVisible({
      bounds: { height: 300, width: 400, x: 400, y: 200 },
      containerHeight: 800,
      containerWidth: 1200,
      insets: { left: 376 },
      viewport: { x: 0, y: 0, zoom: 1 },
    })).toBe(true)
    expect(isTeamCanvasBoundsVisible({
      bounds: { height: 300, width: 400, x: 120, y: 200 },
      containerHeight: 800,
      containerWidth: 1200,
      insets: { left: 376 },
      viewport: { x: 0, y: 0, zoom: 1 },
    })).toBe(false)
  })
})
