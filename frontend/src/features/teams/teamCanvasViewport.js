export const EMPTY_TEAM_CANVAS_INSETS = Object.freeze({
  bottom: 0,
  left: 0,
  right: 0,
  top: 0,
})

const BASE_FIT_INSETS = Object.freeze({
  bottom: 30,
  left: 30,
  right: 30,
  top: 150,
})

function finiteInset(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

export function normalizeTeamCanvasInsets(insets) {
  return {
    bottom: finiteInset(insets?.bottom),
    left: finiteInset(insets?.left),
    right: finiteInset(insets?.right),
    top: finiteInset(insets?.top),
  }
}

export function hasTeamCanvasInsets(insets) {
  const normalized = normalizeTeamCanvasInsets(insets)
  return Object.values(normalized).some((value) => value > 0)
}

export function teamCanvasInsetsEqual(first, second) {
  const left = normalizeTeamCanvasInsets(first)
  const right = normalizeTeamCanvasInsets(second)
  return left.bottom === right.bottom
    && left.left === right.left
    && left.right === right.right
    && left.top === right.top
}

export function calculateTeamCanvasPanelInset({
  containerHeight,
  containerWidth,
  gap = 16,
  panelHeight,
  panelLeft,
  panelTop,
  panelWidth,
  side,
}) {
  const width = finiteInset(containerWidth)
  const height = finiteInset(containerHeight)
  const left = finiteInset(panelLeft)
  const top = finiteInset(panelTop)
  const measuredWidth = finiteInset(panelWidth)
  const measuredHeight = finiteInset(panelHeight)
  const spacing = finiteInset(gap)

  if (side === 'left') return Math.min(width, left + measuredWidth + spacing)
  if (side === 'right') return Math.min(width, Math.max(0, width - left) + spacing)
  if (side === 'top') return Math.min(height, top + measuredHeight + spacing)
  if (side === 'bottom') return Math.min(height, Math.max(0, height - top) + spacing)
  return 0
}

export function resolveTeamCanvasFitInsets(insets, baseInsets = BASE_FIT_INSETS) {
  const safe = normalizeTeamCanvasInsets(insets)
  const base = normalizeTeamCanvasInsets(baseInsets)
  return {
    bottom: Math.max(base.bottom, safe.bottom),
    left: Math.max(base.left, safe.left),
    right: Math.max(base.right, safe.right),
    top: Math.max(base.top, safe.top),
  }
}

export function buildTeamCanvasFitPadding(insets, baseInsets = BASE_FIT_INSETS) {
  const resolved = resolveTeamCanvasFitInsets(insets, baseInsets)
  return {
    bottom: `${resolved.bottom}px`,
    left: `${resolved.left}px`,
    right: `${resolved.right}px`,
    top: `${resolved.top}px`,
  }
}

export function calculateTeamCanvasMotionBounds(nodes, nodeSize) {
  const size = Math.max(0, Number(nodeSize) || 0)
  if (!Array.isArray(nodes) || nodes.length === 0 || size === 0) return null

  let minimumX = Number.POSITIVE_INFINITY
  let minimumY = Number.POSITIVE_INFINITY
  let maximumX = Number.NEGATIVE_INFINITY
  let maximumY = Number.NEGATIVE_INFINITY

  const include = (position) => {
    const x = Number(position?.x)
    const y = Number(position?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minimumX = Math.min(minimumX, x)
    minimumY = Math.min(minimumY, y)
    maximumX = Math.max(maximumX, x + size)
    maximumY = Math.max(maximumY, y + size)
  }

  for (const node of nodes) {
    include(node.position)
    include(node.data?.anchor)
  }

  if (!Number.isFinite(minimumX) || !Number.isFinite(minimumY)) return null
  return {
    height: maximumY - minimumY,
    width: maximumX - minimumX,
    x: minimumX,
    y: minimumY,
  }
}

export function isTeamCanvasBoundsVisible({
  bounds,
  containerHeight,
  containerWidth,
  insets,
  viewport,
}) {
  const width = Number(containerWidth)
  const height = Number(containerHeight)
  const zoom = Number(viewport?.zoom)
  if (!bounds || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  if (!Number.isFinite(zoom) || zoom <= 0) return false

  const safe = resolveTeamCanvasFitInsets(insets)
  const left = (bounds.x * zoom) + Number(viewport?.x || 0)
  const top = (bounds.y * zoom) + Number(viewport?.y || 0)
  const right = left + (bounds.width * zoom)
  const bottom = top + (bounds.height * zoom)

  return left >= safe.left
    && top >= safe.top
    && right <= width - safe.right
    && bottom <= height - safe.bottom
}
