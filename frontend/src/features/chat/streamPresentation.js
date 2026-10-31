const MIN_REVEAL_DELAY_MS = 18
const MAX_REVEAL_DELAY_MS = 36
const NATURAL_BREAK_LOOKAHEAD = 8
const PROVIDER_BURST_THRESHOLD = 8

let graphemeSegmenter

export function segmentGraphemes(value) {
  const content = String(value || '')
  if (!content) return []

  if (typeof Intl?.Segmenter === 'function') {
    graphemeSegmenter ||= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(graphemeSegmenter.segment(content), ({ segment }) => segment)
  }

  return Array.from(content)
}

function isNaturalBreak(grapheme) {
  return /[\s.,!?;:)}\]]/u.test(grapheme)
}

function desiredFragmentSize(backlog, terminal) {
  if (backlog <= PROVIDER_BURST_THRESHOLD) return backlog

  const liveSize = Math.max(2, Math.ceil(Math.sqrt(backlog) / 2))
  return Math.min(terminal ? 18 : 12, terminal ? Math.ceil(liveSize * 1.5) : liveSize)
}

export function streamingRevealDelay(backlog, { terminal = false } = {}) {
  if (backlog <= 0) return MAX_REVEAL_DELAY_MS

  // Logarithmic pressure lets the cadence accelerate continuously as unread
  // text accumulates without introducing perceptible speed bands.
  const pressure = Math.min(1, Math.log2(backlog + 1) / 9)
  const delay = MAX_REVEAL_DELAY_MS - ((MAX_REVEAL_DELAY_MS - MIN_REVEAL_DELAY_MS) * pressure)
  return Math.max(MIN_REVEAL_DELAY_MS, terminal ? delay - 4 : delay)
}

export function nextBottomFollowPosition(current, target) {
  if (!Number.isFinite(current) || !Number.isFinite(target)) {
    return target
  }

  const distance = target - current
  if (Math.abs(distance) <= 0.75) return target

  const step = Math.max(1, Math.abs(distance) * 0.24)
  return current + Math.sign(distance) * Math.min(Math.abs(distance), step)
}

export function nextStreamingRevealCount(visibleCount, target, { terminal = false } = {}) {
  const targetCount = target.length
  if (visibleCount >= targetCount) return targetCount

  const backlog = targetCount - visibleCount
  const fragmentEnd = Math.min(targetCount, visibleCount + desiredFragmentSize(backlog, terminal))
  const lookaheadEnd = Math.min(targetCount, fragmentEnd + NATURAL_BREAK_LOOKAHEAD)

  // Prefer ending a buffered fragment where a reader naturally perceives a
  // boundary. Previously rendered text is never revisited or rewritten.
  for (let index = fragmentEnd; index < lookaheadEnd; index += 1) {
    if (isNaturalBreak(target[index])) return index + 1
  }

  return fragmentEnd
}
