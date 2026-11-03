import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import {
  isDeploymentTransitional,
  resourceBase,
  RESOURCE_KINDS,
} from '../features/deployments/deploymentState'
import { useApiClient } from './useApiClient'

const initialState = {
  capabilities: null,
  deployments: [],
  error: null,
  loading: true,
  resources: [],
}

function pageItems(page) {
  return Array.isArray(page?.items) ? page.items : []
}

function mutationKey(operation, resourceId, detail = '') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${operation}-${resourceId}-${detail}-${id}`.replaceAll(/[^\x21-\x7e]/g, '-')
}

function operationError(error) {
  if (error?.status === 409) {
    return 'The deployment changed while this action was in progress. AgentFlow refreshed the current state; review it and retry.'
  }
  if (error?.status === 422) {
    return error.message || 'This resource cannot be published until its configuration is complete.'
  }
  return error?.message || 'The deployment action could not be completed.'
}

export function useDeploymentWorkspace() {
  const api = useApiClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState(initialState)
  const [publications, setPublications] = useState([])
  const [status, setStatus] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [action, setAction] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const idempotencyKeys = useRef(new Map())
  const restoreProgress = useRef(new Map())

  const requestedKind = searchParams.get('resource_kind')
  const requestedId = searchParams.get('resource_id')

  const selectedResource = useMemo(() => {
    const exact = state.resources.find((resource) => (
      resource.id === requestedId && resource.resource_kind === requestedKind
    ))
    return exact || state.resources[0] || null
  }, [requestedId, requestedKind, state.resources])
  const knownStatus = status || state.deployments.find((item) => (
    item.resource_id === selectedResource?.id
  )) || null

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  const selectResource = useCallback((resource) => {
    if (!resource) return
    setSearchParams({
      resource_id: resource.id,
      resource_kind: resource.resource_kind,
    }, { replace: true })
    setActionError(null)
  }, [setSearchParams])

  useEffect(() => {
    const controller = new AbortController()

    async function loadWorkspace() {
      setState((current) => ({ ...current, error: null, loading: true }))
      try {
        const [capabilities, agents, teams] = await Promise.all([
          api.get('/platform/capabilities', { signal: controller.signal }),
          api.get('/agents', { signal: controller.signal }),
          api.get('/agent-teams', { signal: controller.signal }),
        ])
        const resources = [
          ...(Array.isArray(agents) ? agents : []).map((resource) => ({
            ...resource,
            resource_kind: RESOURCE_KINDS.AGENT,
          })),
          ...(Array.isArray(teams) ? teams : []).map((resource) => ({
            ...resource,
            resource_kind: RESOURCE_KINDS.TEAM,
          })),
        ]
        let deployments = []
        if (capabilities?.managed_deployments) {
          const page = await api.get('/deployments?limit=100', { signal: controller.signal })
          deployments = pageItems(page)
        }
        setState({ capabilities, deployments, error: null, loading: false, resources })
      } catch (error) {
        if (error.name === 'AbortError') return
        setState({ ...initialState, error, loading: false })
      }
    }

    loadWorkspace()
    return () => controller.abort()
  }, [api, reloadKey])

  const refreshStatus = useCallback(async ({ signal } = {}) => {
    if (!selectedResource || !state.capabilities?.managed_deployments) {
      setStatus(null)
      return null
    }
    const base = resourceBase(selectedResource.resource_kind)
    try {
      const nextStatus = await api.get(`${base}/${selectedResource.id}/deployment`, { signal })
      setStatus(nextStatus)
      return nextStatus
    } catch (error) {
      if (error?.status === 404) {
        setStatus(null)
        setState((current) => ({
          ...current,
          deployments: current.deployments.filter((item) => item.resource_id !== selectedResource.id),
        }))
        return null
      }
      throw error
    }
  }, [api, selectedResource, state.capabilities?.managed_deployments])

  const refreshPublications = useCallback(async ({ signal } = {}) => {
    if (!selectedResource) {
      setPublications([])
      return []
    }
    const base = resourceBase(selectedResource.resource_kind)
    const page = await api.get(`${base}/${selectedResource.id}/publications?limit=100`, { signal })
    const items = pageItems(page)
    setPublications(items)
    return items
  }, [api, selectedResource])

  const refreshDetail = useCallback(async ({ quiet = false, signal } = {}) => {
    if (!selectedResource) {
      setPublications([])
      setStatus(null)
      return
    }
    if (!quiet) setDetailLoading(true)
    try {
      await Promise.all([
        refreshPublications({ signal }),
        refreshStatus({ signal }),
      ])
    } finally {
      if (!quiet) setDetailLoading(false)
    }
  }, [refreshPublications, refreshStatus, selectedResource])

  useEffect(() => {
    const controller = new AbortController()
    setActionError(null)
    setPublications([])
    setStatus(null)
    refreshDetail({ signal: controller.signal }).catch((error) => {
      if (error.name !== 'AbortError') setActionError(operationError(error))
    })
    return () => controller.abort()
  }, [refreshDetail])

  useEffect(() => {
    if (!isDeploymentTransitional(status)) return undefined
    let cancelled = false
    let timer

    const poll = async () => {
      if (cancelled) return
      if (document.visibilityState === 'visible') {
        try {
          await refreshStatus()
        } catch (error) {
          if (!cancelled) setActionError(operationError(error))
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, 2500)
    }

    timer = window.setTimeout(poll, 2500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [refreshStatus, status])

  const runAction = useCallback(async (name, work) => {
    setAction(name)
    setActionError(null)
    try {
      const result = await work()
      await refreshDetail({ quiet: true })
      setState((current) => {
        if (!result?.resource_id) return current
        const exists = current.deployments.some((item) => item.resource_id === result.resource_id)
        return {
          ...current,
          deployments: exists
            ? current.deployments.map((item) => item.resource_id === result.resource_id ? result : item)
            : [result, ...current.deployments],
        }
      })
      return result
    } catch (error) {
      try {
        await refreshDetail({ quiet: true })
      } catch {
        // Preserve the original mutation error; the explicit refresh action remains available.
      }
      setActionError(operationError(error))
      throw error
    } finally {
      setAction(null)
    }
  }, [refreshDetail])

  const withIdempotencyKey = useCallback(async (signature, work) => {
    let key = idempotencyKeys.current.get(signature)
    if (!key) {
      key = mutationKey('publication', selectedResource?.id || 'resource', signature)
      idempotencyKeys.current.set(signature, key)
    }
    try {
      const result = await work(key)
      idempotencyKeys.current.delete(signature)
      return result
    } catch (error) {
      if (error instanceof ApiError && error.status > 0) idempotencyKeys.current.delete(signature)
      throw error
    }
  }, [selectedResource?.id])

  const publish = useCallback(() => runAction('publish', async () => {
    const base = resourceBase(selectedResource.resource_kind)
    return withIdempotencyKey(`publish:${selectedResource.id}`, (key) => api.post(
      `${base}/${selectedResource.id}/publish`,
      undefined,
      { headers: { 'Idempotency-Key': key } },
    ))
  }), [api, runAction, selectedResource, withIdempotencyKey])

  const deploy = useCallback((revision) => runAction(`deploy:${revision}`, async () => {
    const base = resourceBase(selectedResource.resource_kind)
    return api.put(`${base}/${selectedResource.id}/deployment`, {
      expected_generation: knownStatus?.desired_generation || 0,
      revision,
    })
  }), [api, knownStatus?.desired_generation, runAction, selectedResource])

  const restoreAndDeploy = useCallback((sourceRevision) => runAction(`restore:${sourceRevision}`, async () => {
    const base = resourceBase(selectedResource.resource_kind)
    const signature = `${selectedResource.resource_kind}:${selectedResource.id}:${sourceRevision}`
    let progress = restoreProgress.current.get(signature)
    if (!progress) {
      progress = {
        key: mutationKey('restore', selectedResource.id, String(sourceRevision)),
        restoredRevision: null,
      }
      restoreProgress.current.set(signature, progress)
    }
    if (!progress.restoredRevision) {
      try {
        const restored = await api.post(
          `${base}/${selectedResource.id}/publications/${sourceRevision}/restore`,
          undefined,
          { headers: { 'Idempotency-Key': progress.key } },
        )
        progress.restoredRevision = restored.revision
      } catch (error) {
        if (error instanceof ApiError && error.status > 0) restoreProgress.current.delete(signature)
        throw error
      }
    }
    const result = await api.put(`${base}/${selectedResource.id}/deployment`, {
      expected_generation: knownStatus?.desired_generation || 0,
      revision: progress.restoredRevision,
    })
    restoreProgress.current.delete(signature)
    return result
  }), [api, knownStatus?.desired_generation, runAction, selectedResource])

  const undeploy = useCallback(() => runAction('undeploy', async () => {
    const base = resourceBase(selectedResource.resource_kind)
    return api.request(`${base}/${selectedResource.id}/deployment`, {
      json: { expected_generation: knownStatus.desired_generation },
      method: 'DELETE',
    })
  }), [api, knownStatus, runAction, selectedResource])

  return {
    ...state,
    action,
    actionError,
    clearActionError: () => setActionError(null),
    deploy,
    detailLoading,
    publications,
    publish,
    refreshDetail,
    reload,
    restoreAndDeploy,
    selectedResource,
    selectResource,
    status: knownStatus,
    undeploy,
  }
}
