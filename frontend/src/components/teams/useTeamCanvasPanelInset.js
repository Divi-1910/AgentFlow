import { useLayoutEffect, useRef } from 'react'
import { calculateTeamCanvasPanelInset } from '../../features/teams/teamCanvasViewport'

export default function useTeamCanvasPanelInset(side, onInsetChange, active = true) {
  const panelRef = useRef(null)

  useLayoutEffect(() => {
    if (!active) return undefined
    const panel = panelRef.current
    if (!panel || !onInsetChange) return undefined
    const workspace = panel.closest('.team-workspace-page')
    if (!workspace) return undefined

    let frame = null
    const measure = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        onInsetChange(side, calculateTeamCanvasPanelInset({
          containerHeight: workspace.clientHeight,
          containerWidth: workspace.clientWidth,
          panelHeight: panel.offsetHeight,
          panelLeft: panel.offsetLeft,
          panelTop: panel.offsetTop,
          panelWidth: panel.offsetWidth,
          side,
        }))
      })
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure)
    observer?.observe(panel)
    observer?.observe(workspace)
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [active, onInsetChange, side])

  return panelRef
}
