import { useEffect, useRef, useState } from 'react'
import {
  nextStreamingRevealCount,
  segmentGraphemes,
  streamingRevealDelay,
} from '../features/chat/streamPresentation'

const emptyView = Object.freeze({
  handoffMessageId: null,
  sceneKey: null,
  stream: null,
})

function visibleContent(machine) {
  return machine.target.slice(0, machine.visibleCount).join('')
}

function streamView(machine) {
  const content = visibleContent(machine)
  return {
    handoffMessageId: null,
    sceneKey: machine.sceneKey,
    stream: content ? {
      ...machine.metadata,
      content,
      partial: machine.partial,
    } : null,
  }
}

function sameView(previous, next) {
  return previous.handoffMessageId === next.handoffMessageId
    && previous.sceneKey === next.sceneKey
    && previous.stream?.content === next.stream?.content
    && previous.stream?.partial === next.stream?.partial
    && previous.stream?.runId === next.stream?.runId
}

function publishView(setView, next) {
  setView((previous) => sameView(previous, next) ? previous : next)
}

function updateTarget(machine, content) {
  const nextContent = String(content || '')
  const currentVisibleContent = visibleContent(machine)
  const target = segmentGraphemes(nextContent)

  if (!nextContent.startsWith(currentVisibleContent)) {
    machine.visibleCount = 0
  } else {
    machine.visibleCount = Math.min(machine.visibleCount, target.length)
  }
  machine.target = target
}

function markTerminal(machine) {
  machine.terminal = true
}

function durableAssistant(messages, runId) {
  if (!runId) return null
  return messages.find((message) => (
    message.role === 'assistant'
    && message.run_id === runId
    && typeof message.content === 'string'
  )) || null
}

export function useStreamPresentation({
  messages,
  partial,
  reducedMotion,
  sceneKey,
  stream,
}) {
  const machineRef = useRef(null)
  const frameRef = useRef(null)
  const [view, setView] = useState(emptyView)

  useEffect(() => {
    let machine = machineRef.current
    const streamKey = stream ? `${stream.runId}:${stream.attempt || 1}` : null

    if (machine?.sceneKey !== sceneKey) {
      machine = null
      machineRef.current = null
    }

    if (stream && machine?.streamKey !== streamKey) {
      machine = {
        durableMessageId: null,
        metadata: { ...stream },
        partial: Boolean(partial),
        sceneKey,
        streamKey,
        target: [],
        terminal: false,
        visibleCount: 0,
      }
      updateTarget(machine, stream.content)
      machineRef.current = machine
    } else if (stream && machine) {
      machine.metadata = { ...stream }
      machine.partial = Boolean(partial)
      updateTarget(machine, stream.content)
    }

    if (!machine) return

    const durable = durableAssistant(messages, machine.metadata.runId)
    if (durable) {
      machine.durableMessageId = durable.id
      updateTarget(machine, durable.content)
      markTerminal(machine)
    } else if (stream?.complete) {
      markTerminal(machine)
    }

    if (reducedMotion) return undefined

    function tick(now) {
      const machine = machineRef.current
      if (!machine || machine.sceneKey !== sceneKey) return

      const targetCount = machine.target.length
      const backlog = targetCount - machine.visibleCount
      const revealDelay = streamingRevealDelay(backlog, { terminal: machine.terminal })
      if (machine.lastFrameAt && now - machine.lastFrameAt < revealDelay) {
        frameRef.current = window.requestAnimationFrame(tick)
        return
      }
      machine.lastFrameAt = now

      const nextCount = nextStreamingRevealCount(
        machine.visibleCount,
        machine.target,
        { terminal: machine.terminal },
      )

      if (nextCount !== machine.visibleCount) {
        machine.visibleCount = nextCount
        publishView(setView, streamView(machine))
      }

      if (machine.visibleCount < targetCount) {
        frameRef.current = window.requestAnimationFrame(tick)
        return
      }

      if (machine.durableMessageId) {
        const handoffMessageId = machine.durableMessageId
        machineRef.current = null
        publishView(setView, { handoffMessageId, sceneKey, stream: null })
      }
    }

    frameRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [messages, partial, reducedMotion, sceneKey, stream])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  if (reducedMotion) {
    const matchingDurable = durableAssistant(messages, stream?.runId)
    return {
      handoffMessageId: matchingDurable && !stream ? matchingDurable.id : null,
      stream: stream?.content ? { ...stream, partial: Boolean(partial) } : null,
      suppressedMessageId: stream?.content ? matchingDurable?.id || null : null,
    }
  }

  const currentView = view.sceneKey === sceneKey ? view : emptyView
  const activeRunId = stream?.runId || currentView.stream?.runId
  const matchingDurable = durableAssistant(messages, activeRunId)
  const hasPresentation = Boolean(stream?.content || currentView.stream?.content)

  return {
    handoffMessageId: currentView.handoffMessageId,
    stream: currentView.stream,
    suppressedMessageId: hasPresentation ? matchingDurable?.id || null : null,
  }
}
