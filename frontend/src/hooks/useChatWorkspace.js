import { useAtom, useSetAtom, useStore } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { parseEventStream } from '../api/sse'
import { canResumeRun, isRunActive } from '../features/chat/chatState'
import {
  chatRuntimeAtom,
  dispatchChatRuntimeAtom,
  selectedChatResourceAtom,
  selectedChatThreadIdAtom,
} from '../store/atoms/chatAtoms'
import { useApiClient } from './useApiClient'

const PAGE_LIMIT = 200
const ROOT_TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled'])

function pageItems(page) {
  return Array.isArray(page?.items) ? page.items : []
}

function timeValue(value) {
  const time = new Date(value || 0).getTime()
  return Number.isNaN(time) ? 0 : time
}

function sortThreads(threads) {
  return [...threads].sort((left, right) => timeValue(right.updated_at) - timeValue(left.updated_at))
}

function sortMessages(messages) {
  return [...messages].sort((left, right) => timeValue(left.created_at) - timeValue(right.created_at))
}

function sortRuns(runs) {
  return [...runs].sort((left, right) => timeValue(right.updated_at) - timeValue(left.updated_at))
}

function resourceKind(resource) {
  return resource?.resource_kind || (Array.isArray(resource?.nodes) ? 'agent_team' : 'standalone_agent')
}

function wait(delay, signal) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, delay)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

export function useChatWorkspace() {
  const api = useApiClient()
  const location = useLocation()
  const navigate = useNavigate()
  const store = useStore()
  const initialSearchParams = useRef(new URLSearchParams(location.search))
  const initialSelection = useRef({
    resourceId: initialSearchParams.current.get('resource_id'),
    resourceKind: initialSearchParams.current.get('resource_kind'),
    threadId: initialSearchParams.current.get('thread_id'),
  })
  const [selectedThreadId, setSelectedThreadId] = useAtom(selectedChatThreadIdAtom)
  const [selectedResource, setSelectedResource] = useAtom(selectedChatResourceAtom)
  const dispatchRuntime = useSetAtom(dispatchChatRuntimeAtom)
  const streamControllerRef = useRef(null)
  const createdThreadRef = useRef(null)
  const selectedThreadIdRef = useRef(selectedThreadId)
  const queuedDeltaEventsRef = useRef([])
  const deltaFrameRef = useRef(null)
  const [workspace, setWorkspace] = useState({
    error: null,
    loading: true,
    resources: [],
    threads: [],
  })
  const [messages, setMessages] = useState([])
  const [latestRun, setLatestRun] = useState(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [retrySubmission, setRetrySubmission] = useState(null)

  selectedThreadIdRef.current = selectedThreadId

  const resourcesById = useMemo(
    () => new Map(workspace.resources.map((resource) => [resource.id, resource])),
    [workspace.resources],
  )
  const selectedThread = useMemo(
    () => workspace.threads.find((thread) => thread.id === selectedThreadId) || null,
    [selectedThreadId, workspace.threads],
  )

  const updateURL = useCallback((selection) => {
    const next = new URLSearchParams()
    if (selection.threadId) next.set('thread_id', selection.threadId)
    if (selection.resourceId) next.set('resource_id', selection.resourceId)
    if (selection.resourceKind) next.set('resource_kind', selection.resourceKind)
    const search = next.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true })
  }, [location.pathname, navigate])

  const flushQueuedDeltas = useCallback(() => {
    const events = queuedDeltaEventsRef.current
    if (events.length === 0) return
    queuedDeltaEventsRef.current = []
    dispatchRuntime({ type: 'event.batch', events })
  }, [dispatchRuntime])

  const queueDelta = useCallback((event) => {
    queuedDeltaEventsRef.current.push(event)
    if (deltaFrameRef.current !== null) return
    deltaFrameRef.current = window.requestAnimationFrame(() => {
      deltaFrameRef.current = null
      flushQueuedDeltas()
    })
  }, [flushQueuedDeltas])

  const clearQueuedDeltas = useCallback(() => {
    queuedDeltaEventsRef.current = []
    if (deltaFrameRef.current !== null) {
      window.cancelAnimationFrame(deltaFrameRef.current)
      deltaFrameRef.current = null
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadWorkspace() {
      setWorkspace((current) => ({ ...current, error: null, loading: true }))
      try {
        const [threadPage, agents, teams] = await Promise.all([
          api.get(`/threads?limit=${PAGE_LIMIT}`, { signal: controller.signal }),
          api.get('/agents', { signal: controller.signal }),
          api.get('/agent-teams', { signal: controller.signal }),
        ])
        const resources = [
          ...(Array.isArray(agents) ? agents : []).map((agent) => ({ ...agent, resource_kind: 'standalone_agent' })),
          ...(Array.isArray(teams) ? teams : []).map((team) => ({ ...team, resource_kind: 'agent_team' })),
        ]
        const threads = sortThreads(pageItems(threadPage))
        setWorkspace({ error: null, loading: false, resources, threads })

        const requestedThread = threads.find((thread) => thread.id === initialSelection.current.threadId)
        const requestedResource = resources.find((resource) => (
          resource.id === initialSelection.current.resourceId
          && (!initialSelection.current.resourceKind || resourceKind(resource) === initialSelection.current.resourceKind)
        ))
        if (requestedThread) {
          selectedThreadIdRef.current = requestedThread.id
          setSelectedThreadId(requestedThread.id)
          setSelectedResource(resources.find((resource) => resource.id === requestedThread.resource_id) || null)
        } else if (requestedResource) {
          selectedThreadIdRef.current = null
          setSelectedThreadId(null)
          setSelectedResource(requestedResource)
        } else if (threads[0]) {
          selectedThreadIdRef.current = threads[0].id
          setSelectedThreadId(threads[0].id)
          setSelectedResource(resources.find((resource) => resource.id === threads[0].resource_id) || null)
          updateURL({ threadId: threads[0].id })
        } else {
          selectedThreadIdRef.current = null
          setSelectedThreadId(null)
          setSelectedResource(resources[0] || null)
          if (resources[0]) updateURL({ resourceId: resources[0].id, resourceKind: resourceKind(resources[0]) })
        }
      } catch (error) {
        if (error.name === 'AbortError') return
        setWorkspace({ error, loading: false, resources: [], threads: [] })
      }
    }

    loadWorkspace()
    return () => controller.abort()
  }, [api, setSelectedResource, setSelectedThreadId, updateURL])

  useEffect(() => {
    if (workspace.loading) return
    const params = new URLSearchParams(location.search)
    const threadId = params.get('thread_id')
    const resourceId = params.get('resource_id')
    const thread = threadId ? workspace.threads.find((item) => item.id === threadId) : null
    const resource = resourceId ? workspace.resources.find((item) => item.id === resourceId) : null

    if (thread && thread.id !== selectedThreadIdRef.current) {
      streamControllerRef.current?.abort()
      clearQueuedDeltas()
      selectedThreadIdRef.current = thread.id
      setThreadLoading(true)
      setMessages([])
      setLatestRun(null)
      setSelectedThreadId(thread.id)
      setSelectedResource(workspace.resources.find((item) => item.id === thread.resource_id) || null)
      return
    }
    if (!threadId && resource && selectedThreadIdRef.current !== null) {
      streamControllerRef.current?.abort()
      clearQueuedDeltas()
      selectedThreadIdRef.current = null
      setSelectedThreadId(null)
      setSelectedResource(resource)
      setMessages([])
      setLatestRun(null)
      setThreadLoading(false)
      dispatchRuntime({ type: 'reset' })
    }
  }, [
    clearQueuedDeltas,
    dispatchRuntime,
    location.search,
    setSelectedResource,
    setSelectedThreadId,
    workspace.loading,
    workspace.resources,
    workspace.threads,
  ])

  const loadDurableState = useCallback(async (threadId, { signal } = {}) => {
    const [messagePage, runPage] = await Promise.all([
      api.get(`/threads/${threadId}/messages?limit=${PAGE_LIMIT}`, { signal }),
      api.get(`/threads/${threadId}/runs?limit=${PAGE_LIMIT}`, { signal }),
    ])
    const durableMessages = sortMessages(pageItems(messagePage))
    const runs = sortRuns(pageItems(runPage))
    if (selectedThreadIdRef.current === threadId) {
      setMessages(durableMessages)
      setLatestRun(runs[0] || null)
      dispatchRuntime({ type: 'reconciled' })
    }
    return { messages: durableMessages, run: runs[0] || null }
  }, [api, dispatchRuntime])

  const observeRun = useCallback(async ({
    controller,
    initialPath,
    initialOptions,
    knownRunId,
    threadId,
  }) => {
    let runId = knownRunId || null
    let lastEventId = knownRunId ? store.get(chatRuntimeAtom).lastEventId : ''
    let accepted = Boolean(knownRunId)
    let finalError = null

    for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt += 1) {
      const useInitialRequest = !runId || (attempt === 0 && Boolean(initialPath) && Boolean(knownRunId))
      const path = useInitialRequest ? initialPath : `/runs/${runId}/events`
      const options = useInitialRequest
        ? { ...initialOptions, signal: controller.signal }
        : {
            method: 'GET',
            headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
            signal: controller.signal,
          }

      dispatchRuntime({ type: 'connection', connection: attempt === 0 ? 'connecting' : 'reconnecting' })
      try {
        const stream = await api.stream(path, options)
        dispatchRuntime({ type: 'connection', connection: 'streaming' })
        for await (const packet of parseEventStream(stream, { signal: controller.signal })) {
          if (!packet.data || typeof packet.data !== 'object') continue
          const event = packet.data
          if (!event.type && packet.event) event.type = packet.event
          if (!event.stream_id && packet.id) event.stream_id = packet.id
          if (event.type === 'run.accepted') {
            runId = event.run_id
            accepted = true
            setLatestRun((current) => ({
              ...current,
              id: runId,
              status: event.status || 'running',
              attempt: event.attempt || 1,
              thread_id: threadId,
            }))
          }
          if (event.stream_id) lastEventId = event.stream_id
          if (event.type === 'model.delta') {
            queueDelta(event)
          } else {
            flushQueuedDeltas()
            dispatchRuntime({ type: 'event', event })
          }

          if (event.run_id === runId && (
            ROOT_TERMINAL_EVENTS.has(event.type)
            || event.type === 'run.waiting'
            || event.type === 'run.resumed'
          )) {
            setLatestRun((current) => current ? {
              ...current,
              status: event.type.replace('run.', '').replace('waiting', 'waiting_for_jobs'),
            } : current)
          }
          if (event.type === 'stream.reset') {
            flushQueuedDeltas()
            await loadDurableState(threadId, { signal: controller.signal })
            return { accepted, runId }
          }
        }

        flushQueuedDeltas()
        await loadDurableState(threadId, { signal: controller.signal })
        return { accepted, runId }
      } catch (error) {
        if (error.name === 'AbortError' || controller.signal.aborted) return { aborted: true, accepted, runId }
        finalError = error
        if (error.status === 410 && runId) {
          await loadDurableState(threadId, { signal: controller.signal })
          dispatchRuntime({ type: 'connection', connection: 'closed' })
          return { accepted, runId }
        }
        if (attempt < 2) {
          await wait(500 * (attempt + 1), controller.signal)
        }
      }
    }

    try {
      const durable = await loadDurableState(threadId, { signal: controller.signal })
      if (!accepted && durable.run && isRunActive(durable.run.status)) {
        accepted = true
        runId = durable.run.id
      }
    } catch (reconcileError) {
      if (reconcileError.name !== 'AbortError') finalError = finalError || reconcileError
    }
    dispatchRuntime({
      type: 'connection',
      connection: 'interrupted',
      error: finalError?.message || 'The live connection was interrupted.',
    })
    return { accepted, error: finalError, runId }
  }, [api, dispatchRuntime, flushQueuedDeltas, loadDurableState, queueDelta, store])

  useEffect(() => {
    if (!selectedThreadId || workspace.loading) {
      if (!selectedThreadId) {
        clearQueuedDeltas()
        setMessages([])
        setLatestRun(null)
        dispatchRuntime({ type: 'reset' })
      }
      return undefined
    }
    if (createdThreadRef.current === selectedThreadId) {
      createdThreadRef.current = null
      return undefined
    }

    streamControllerRef.current?.abort()
    clearQueuedDeltas()
    const controller = new AbortController()
    streamControllerRef.current = controller
    setThreadLoading(true)
    setActionError(null)
    dispatchRuntime({ type: 'reset' })

    loadDurableState(selectedThreadId, { signal: controller.signal })
      .then(({ run }) => {
        if (selectedThreadIdRef.current === selectedThreadId) setThreadLoading(false)
        if (run && isRunActive(run.status) && !controller.signal.aborted) {
          dispatchRuntime({ type: 'begin', runId: run.id, status: run.status })
          void observeRun({ controller, knownRunId: run.id, threadId: selectedThreadId })
        }
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        if (selectedThreadIdRef.current === selectedThreadId) {
          setThreadLoading(false)
          setActionError(error)
        }
      })

    return () => controller.abort()
  }, [clearQueuedDeltas, dispatchRuntime, loadDurableState, observeRun, selectedThreadId, workspace.loading])

  useEffect(() => () => {
    streamControllerRef.current?.abort()
    clearQueuedDeltas()
  }, [clearQueuedDeltas])

  const selectThread = useCallback((thread) => {
    streamControllerRef.current?.abort()
    clearQueuedDeltas()
    selectedThreadIdRef.current = thread.id
    setThreadLoading(true)
    setMessages([])
    setLatestRun(null)
    setSelectedThreadId(thread.id)
    setSelectedResource(resourcesById.get(thread.resource_id) || null)
    setRetrySubmission(null)
    updateURL({ threadId: thread.id })
  }, [clearQueuedDeltas, resourcesById, setSelectedResource, setSelectedThreadId, updateURL])

  const selectResource = useCallback((resource) => {
    streamControllerRef.current?.abort()
    clearQueuedDeltas()
    selectedThreadIdRef.current = null
    setSelectedThreadId(null)
    setSelectedResource(resource)
    setMessages([])
    setLatestRun(null)
    setRetrySubmission(null)
    dispatchRuntime({ type: 'reset' })
    updateURL({ resourceId: resource.id, resourceKind: resourceKind(resource) })
  }, [clearQueuedDeltas, dispatchRuntime, setSelectedResource, setSelectedThreadId, updateURL])

  const createThread = useCallback(async (resource) => {
    const kind = resourceKind(resource)
    const path = kind === 'agent_team'
      ? `/agent-teams/${resource.id}/threads`
      : `/agents/${resource.id}/threads`
    const thread = await api.post(path, { title: 'New conversation' })
    createdThreadRef.current = thread.id
    setWorkspace((current) => ({
      ...current,
      threads: sortThreads([thread, ...current.threads.filter((item) => item.id !== thread.id)]),
    }))
    selectedThreadIdRef.current = thread.id
    setSelectedThreadId(thread.id)
    setSelectedResource(resource)
    updateURL({ threadId: thread.id })
    return thread
  }, [api, setSelectedResource, setSelectedThreadId, updateURL])

  const sendMessage = useCallback(async (content, retry = null) => {
    const trimmed = content.trim()
    if (
      !trimmed
      || submitting
      || isRunActive(latestRun?.status)
      || isRunActive(store.get(chatRuntimeAtom).status)
    ) return false
    setSubmitting(true)
    setActionError(null)

    let thread = selectedThread
    let submission = retry
    try {
      if (!thread) {
        if (!selectedResource) throw new Error('Choose an agent or team before sending a message.')
        thread = await createThread(selectedResource)
      }

      submission = retry || {
        content: trimmed,
        idempotencyKey: crypto.randomUUID(),
        threadId: thread.id,
      }
      setRetrySubmission(null)
      if (!retry) {
        setMessages((current) => [...current, {
          content: trimmed,
          created_at: new Date().toISOString(),
          id: `optimistic-${submission.idempotencyKey}`,
          pending: true,
          role: 'user',
        }])
      }
      dispatchRuntime({ type: 'begin' })
      const controller = new AbortController()
      streamControllerRef.current?.abort()
      streamControllerRef.current = controller
      const result = await observeRun({
        controller,
        initialOptions: {
          headers: { 'Idempotency-Key': submission.idempotencyKey },
          json: { content: submission.content },
          method: 'POST',
        },
        initialPath: `/threads/${thread.id}/messages`,
        threadId: thread.id,
      })
      if (result?.error) {
        setActionError(result.error)
        if (!result.accepted) setRetrySubmission(submission)
      }
      return !result?.error
    } catch (error) {
      if (error.name !== 'AbortError') {
        setActionError(error)
        if (thread) {
          setRetrySubmission(submission || {
            content: trimmed,
            idempotencyKey: crypto.randomUUID(),
            threadId: thread.id,
          })
        }
      }
      return false
    } finally {
      setSubmitting(false)
    }
  }, [createThread, dispatchRuntime, latestRun?.status, observeRun, selectedResource, selectedThread, store, submitting])

  const retryMessage = useCallback(() => {
    if (!retrySubmission) return Promise.resolve(false)
    return sendMessage(retrySubmission.content, retrySubmission)
  }, [retrySubmission, sendMessage])

  const cancelRun = useCallback(async () => {
    if (!latestRun?.id) return
    setActionError(null)
    try {
      const run = await api.post(`/runs/${latestRun.id}/cancel`)
      setLatestRun(run)
    } catch (error) {
      setActionError(error)
    }
  }, [api, latestRun?.id])

  const resumeRun = useCallback(async () => {
    if (!selectedThreadId || !canResumeRun(latestRun)) return
    setActionError(null)
    dispatchRuntime({ type: 'begin', runId: latestRun.id, status: 'running' })
    const controller = new AbortController()
    streamControllerRef.current?.abort()
    streamControllerRef.current = controller
    await observeRun({
      controller,
      initialOptions: { method: 'POST' },
      initialPath: `/runs/${latestRun.id}/resume`,
      knownRunId: latestRun.id,
      threadId: selectedThreadId,
    })
  }, [dispatchRuntime, latestRun, observeRun, selectedThreadId])

  const reconnectRun = useCallback(async () => {
    if (!selectedThreadId || !latestRun?.id) return
    const controller = new AbortController()
    streamControllerRef.current?.abort()
    streamControllerRef.current = controller
    await observeRun({
      controller,
      knownRunId: latestRun.id,
      threadId: selectedThreadId,
    })
  }, [latestRun?.id, observeRun, selectedThreadId])

  const renameThread = useCallback(async (title) => {
    if (!selectedThreadId || !title.trim()) return false
    try {
      const updated = await api.patch(`/threads/${selectedThreadId}`, { title: title.trim() })
      setWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) => thread.id === updated.id ? updated : thread),
      }))
      return true
    } catch (error) {
      setActionError(error)
      return false
    }
  }, [api, selectedThreadId])

  return {
    actionError,
    cancelRun,
    latestRun,
    loading: workspace.loading,
    messages,
    reconnectRun,
    renameThread,
    resources: workspace.resources,
    retryMessage,
    retrySubmission,
    resumeRun,
    selectResource,
    selectThread,
    selectedResource: selectedResource || (selectedThread ? resourcesById.get(selectedThread.resource_id) : null),
    selectedThread,
    sendMessage,
    submitting,
    threadLoading,
    threads: workspace.threads,
    workspaceError: workspace.error,
  }
}
