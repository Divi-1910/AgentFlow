const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled'])
const TRACE_LIMIT = 240

export const initialChatRuntimeState = Object.freeze({
  connection: 'idle',
  error: null,
  events: [],
  lastEventId: '',
  partial: false,
  requiresReconcile: false,
  rootRunId: null,
  status: 'idle',
  streams: {},
  seen: {},
})

function eventIdentity(event) {
  if (event.stream_id) return event.stream_id
  if (event.originator_run_id && Number.isFinite(event.stream_seq)) {
    return `${event.originator_run_id}:${event.stream_seq}`
  }
  return event.id || ''
}

function isTraceEvent(type) {
	return type !== 'model.delta'
}

function eventStatus(event, currentStatus) {
  if (event.type === 'run.accepted') return event.status || 'running'
  if (event.type === 'run.started' || event.type === 'run.resumed') return 'running'
  if (event.type === 'run.waiting') return 'waiting_for_jobs'
  if (event.type === 'run.completed') return 'completed'
  if (event.type === 'run.failed' || event.type === 'run.persist_failed') return 'failed'
  if (event.type === 'run.cancelled') return 'cancelled'
  return currentStatus
}

function reduceRuntimeEvent(state, event) {
  const identity = eventIdentity(event)
  if (identity && state.seen[identity]) return state

  const rootRunId = state.rootRunId
    || event.originator_run_id
    || (event.type === 'run.accepted' ? event.run_id : null)
  const isRootEvent = event.run_id === rootRunId
  const nextSeen = identity ? { ...state.seen, [identity]: true } : state.seen
  let streams = state.streams

  if (event.type === 'model.delta' && event.delta) {
    const runId = event.run_id || rootRunId || 'unknown'
    const previous = streams[runId]
    const attempt = event.attempt || 1
    const content = previous?.attempt === attempt ? previous.content + event.delta : event.delta
    streams = {
      ...streams,
      [runId]: {
        agentId: event.agent_id || previous?.agentId || '',
        agentName: event.agent_name || previous?.agentName || 'Agent',
        attempt,
        complete: false,
        content,
        depth: event.depth || 0,
        runId,
      },
    }
  } else if (event.type === 'model.completed' && streams[event.run_id]) {
    streams = {
      ...streams,
      [event.run_id]: { ...streams[event.run_id], complete: true },
    }
	} else if (event.type === 'run.completed' && event.content) {
		const runId = event.run_id || rootRunId || 'unknown'
		const previous = streams[runId]
		streams = {
			...streams,
			[runId]: {
				agentId: event.agent_id || previous?.agentId || '',
				agentName: event.agent_name || previous?.agentName || 'AgentFlow',
				attempt: event.attempt || previous?.attempt || 1,
				complete: true,
				content: previous?.content || event.content,
				depth: event.depth || previous?.depth || 0,
				runId,
			},
		}
  }

  const events = isTraceEvent(event.type)
    ? [...state.events, event].slice(-TRACE_LIMIT)
    : state.events
  const rootTerminal = isRootEvent && TERMINAL_TYPES.has(event.type)

  return {
    ...state,
    connection: event.type === 'stream.reset'
      ? 'resetting'
      : rootTerminal ? 'closed' : 'streaming',
    error: event.error?.message || (event.type === 'run.persist_failed' ? 'The response could not be saved.' : state.error),
    events,
    lastEventId: event.stream_id || identity || state.lastEventId,
    partial: event.error?.code === 'provider.stream_interrupted' ? hasVisibleDraft({ ...state, streams }) : state.partial,
    requiresReconcile: state.requiresReconcile
      || event.type === 'run.persisted'
      || event.type === 'run.persist_failed'
      || event.type === 'stream.reset'
      || rootTerminal,
    rootRunId,
    seen: nextSeen,
    status: isRootEvent ? eventStatus(event, state.status) : state.status,
    streams,
  }
}

export function chatRuntimeReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return { ...initialChatRuntimeState }
    case 'begin':
      return {
        ...initialChatRuntimeState,
        connection: 'connecting',
        rootRunId: action.runId || null,
        status: action.status || 'running',
      }
    case 'connection':
      return {
        ...state,
        connection: action.connection,
        error: action.error || null,
        partial: action.connection === 'interrupted' ? hasVisibleDraft(state) : state.partial,
      }
    case 'event':
      return reduceRuntimeEvent(state, action.event)
    case 'event.batch':
      return action.events.reduce(reduceRuntimeEvent, state)
    case 'reconciled':
      return {
        ...state,
        partial: false,
        requiresReconcile: false,
        streams: {},
      }
    default:
      return state
  }
}

export function hasVisibleDraft(state) {
  return Object.values(state.streams).some((stream) => stream.content.trim())
}

export function selectPrimaryDraft(state) {
  if (state.rootRunId && state.streams[state.rootRunId]) return state.streams[state.rootRunId]
  return Object.values(state.streams)
    .filter((stream) => stream.depth === 0)
    .at(-1) || null
}

export function isRunActive(status) {
  return ['running', 'cancelling', 'waiting_for_jobs'].includes(status)
}

export function canResumeRun(run) {
  return Boolean(run?.resumable)
    && ['resumable', 'interrupted', 'waiting_for_jobs'].includes(run.status)
}
