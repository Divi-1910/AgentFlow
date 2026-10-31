import { useAtomValue } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import {
  buildExecutionTimeline,
  formatChatTime,
  formatExecutionDuration,
  statusLabel,
} from '../../features/chat/chatPresentation'
import { chatTraceRuntimeAtom } from '../../store/atoms/chatAtoms'

const spring = { damping: 31, stiffness: 330, type: 'spring' }

function DetailSection({ fields, title }) {
  if (!fields?.length) return null
  return (
    <section className="chat-trace-step__section">
      <h4>{title}</h4>
      <dl>
        {fields.map((field, index) => (
          <div key={`${field.label}-${index}`}>
            <dt>{field.label}</dt>
            <dd className={field.format === 'json' ? 'chat-trace-step__code' : undefined}>{field.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function StepDetails({ item }) {
  const hasInput = Boolean(item.input?.length)
  const hasOutput = Boolean(item.output?.length)
  if (!hasInput && !hasOutput) return null

  return (
    <details className="chat-trace-step__details">
      <summary>
        <span>Inspect input and output</span>
        <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
      </summary>
      <div className="chat-trace-step__details-body">
        <DetailSection fields={item.input} title={item.type === 'model' ? 'Visible model input' : 'Tool input'} />
        <DetailSection fields={item.output} title={item.type === 'model' ? 'Model output' : 'Tool output'} />
      </div>
    </details>
  )
}

function TraceStep({ active, item }) {
  const failed = item.status === 'failed'
  const meta = [
    item.agentName,
    item.provider && item.model ? `${item.provider} / ${item.model}` : item.model || item.provider,
    item.durationMs ? formatExecutionDuration(item.durationMs) : '',
    item.time ? formatChatTime(item.time) : '',
  ].filter(Boolean)
  const usage = item.usage || {}
  const usageLabel = usage.total_tokens
    ? `${usage.total_tokens} tokens (${usage.prompt_tokens || 0} in · ${usage.completion_tokens || 0} out)`
    : ''

  return (
    <motion.li
      className={`chat-trace-event chat-trace-event--depth-${Math.min(item.depth || 0, 4)} ${failed ? 'chat-trace-event--failed' : ''}`}
      initial={{ opacity: 0, y: 9 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <div className="chat-trace-event__heading">
        <span className={`chat-trace-event__icon ${active ? 'chat-trace-event__icon--active' : ''}`} aria-hidden="true">
          <span className="material-symbols-outlined">{failed ? 'warning' : item.icon}</span>
        </span>
        <span className="chat-trace-event__copy">
          <strong>{item.title}</strong>
          {item.detail ? <small>{item.detail}</small> : null}
          <span>{meta.join(' · ')}</span>
          {usageLabel ? <em>{usageLabel}</em> : null}
        </span>
        <span className={`chat-trace-event__status chat-trace-event__status--${item.status || 'completed'}`}>
          {item.status === 'running' ? 'Live' : item.status === 'failed' ? 'Failed' : 'Done'}
        </span>
      </div>
      <StepDetails item={item} />
    </motion.li>
  )
}

export default function ChatExecutionTrace({ messages = [], onClose, run = null }) {
  const runtime = useAtomValue(chatTraceRuntimeAtom)
  const reduceMotion = useReducedMotion()
  const executionRunId = runtime.rootRunId || run?.id || ''
  const timeline = useMemo(() => buildExecutionTimeline({
    events: runtime.events,
    messages,
    rootRunId: executionRunId,
    streams: runtime.streams,
  }), [executionRunId, messages, runtime.events, runtime.streams])
  const active = ['connecting', 'reconnecting', 'streaming'].includes(runtime.connection)
  const listRef = useRef(null)

  useEffect(() => {
    const list = listRef.current
    if (!list || !active) return
    list.scrollTo({ behavior: 'auto', top: list.scrollHeight })
  }, [active, timeline.length])

  return (
    <motion.aside
      className="chat-trace"
      initial={reduceMotion ? false : { opacity: 0, x: 22 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, x: 22 }}
      transition={spring}
      aria-label="Execution activity"
      layout
    >
      <header className="chat-trace__header">
        <div>
          <span className={`chat-connection-dot ${active ? 'chat-connection-dot--active' : ''}`} aria-hidden="true" />
          <div>
            <strong>Activity</strong>
            <small>{active ? 'Working now' : timeline.length ? `${timeline.length} ${timeline.length === 1 ? 'step' : 'steps'}` : statusLabel(runtime.status)}</small>
          </div>
        </div>
        <button type="button" className="chat-plain-icon" onClick={onClose} aria-label="Hide execution activity">
          <span className="material-symbols-outlined" aria-hidden="true">right_panel_close</span>
        </button>
      </header>

      <ol className="chat-trace__list" ref={listRef}>
        <AnimatePresence initial={false}>
          {timeline.map((item, index) => (
            <TraceStep
              key={item.id || `${item.type}-${index}`}
              item={item}
              active={active && item.status === 'running' && index === timeline.length - 1}
            />
          ))}
        </AnimatePresence>
        {timeline.length === 0 ? (
          <li className="chat-trace__empty">
            <span className="chat-trace__empty-mark" aria-hidden="true" />
            <strong>{active ? 'AgentFlow is thinking' : 'No activity recorded yet'}</strong>
            <p>Model steps, tool calls, MCP requests, memory changes, and delegated work will appear here.</p>
          </li>
        ) : null}
      </ol>
      <footer className="chat-trace__footer">
        <details>
          <summary>Technical details</summary>
          <span>{executionRunId ? `Run ${executionRunId.slice(0, 8)}` : 'No run identifier'}</span>
          <span>{runtime.events.length} live events · {statusLabel(runtime.connection)}</span>
        </details>
        <p>Only curated, user-visible data is shown. Credentials, private headers, system instructions, and hidden reasoning remain protected.</p>
      </footer>
    </motion.aside>
  )
}
