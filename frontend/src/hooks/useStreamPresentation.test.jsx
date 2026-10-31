import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStreamPresentation } from './useStreamPresentation'

const baseStream = {
  agentName: 'Research agent',
  attempt: 1,
  complete: false,
  content: '',
  runId: 'run-1',
}
const emptyMessages = []

function usePresentation(props) {
  return useStreamPresentation({
    messages: emptyMessages,
    partial: false,
    reducedMotion: false,
    sceneKey: 'thread-1',
    stream: null,
    ...props,
  })
}

describe('useStreamPresentation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback) => window.setTimeout(() => callback(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows fast provider bursts progressively and reaches the exact raw content', () => {
    const content = 'A fast provider response that should remain visibly progressive for the reader.'
    const { result } = renderHook((props) => usePresentation(props), {
      initialProps: { stream: { ...baseStream, content } },
    })

    act(() => vi.advanceTimersByTime(48))
    expect(result.current.stream.content.length).toBeGreaterThan(0)
    expect(result.current.stream.content.length).toBeLessThan(content.length)

    act(() => vi.advanceTimersByTime(1500))
    expect(result.current.stream.content).toBe(content)
  })

  it('keeps an interrupted partial response visible after the raw stream closes', () => {
    const content = 'Partial but useful output.'
    const { result, rerender } = renderHook((props) => usePresentation(props), {
      initialProps: { partial: true, stream: { ...baseStream, content } },
    })

    act(() => vi.advanceTimersByTime(1000))
    rerender({ partial: true, stream: null })

    expect(result.current.stream.content).toBe(content)
    expect(result.current.stream.partial).toBe(true)
  })

  it('cancels the previous presentation when the conversation changes', () => {
    const { result, rerender } = renderHook((props) => usePresentation(props), {
      initialProps: { stream: { ...baseStream, content: 'Previous conversation output' } },
    })

    act(() => vi.advanceTimersByTime(48))
    expect(result.current.stream).not.toBeNull()
    rerender({ sceneKey: 'thread-2', stream: null })

    expect(result.current.stream).toBeNull()
  })

  it('suppresses the durable duplicate until the presentation hands off', () => {
    const content = 'A deliberately long response '.repeat(24)
    const durable = { id: 'message-1', role: 'assistant', run_id: 'run-1', content }
    const { result, rerender } = renderHook((props) => usePresentation(props), {
      initialProps: { stream: { ...baseStream, content } },
    })

    act(() => vi.advanceTimersByTime(48))
    rerender({ messages: [durable], stream: null })

    expect(result.current.stream).not.toBeNull()
    expect(result.current.suppressedMessageId).toBe(durable.id)

    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.stream).toBeNull()
    expect(result.current.suppressedMessageId).toBeNull()
    expect(result.current.handoffMessageId).toBe(durable.id)
  })

  it('reveals immediately when reduced motion is requested', () => {
    const content = 'No paced motion for this reader.'
    const { result } = renderHook((props) => usePresentation(props), {
      initialProps: { reducedMotion: true, stream: { ...baseStream, content } },
    })

    expect(result.current.stream.content).toBe(content)
  })
})
