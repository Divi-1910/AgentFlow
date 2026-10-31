import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from './useApiClient'

const initialState = {
  data: null,
  error: null,
  loading: true,
}

function pageItems(page) {
  return Array.isArray(page?.items) ? page.items : []
}

export function useDashboardData() {
  const api = useApiClient()
  const [state, setState] = useState(initialState)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey((currentKey) => currentKey + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadDashboard() {
      setState((currentState) => ({
        ...currentState,
        error: null,
        loading: true,
      }))

      try {
        const [overview, capabilities, threadPage, runPage, agents, teams] = await Promise.all([
          api.get('/workspace/overview', { signal: controller.signal }),
          api.get('/platform/capabilities', { signal: controller.signal }),
          api.get('/threads?limit=6', { signal: controller.signal }),
          api.get('/runs?limit=6', { signal: controller.signal }),
          api.get('/agents', { signal: controller.signal }),
          api.get('/agent-teams', { signal: controller.signal }),
        ])

        const resourcesById = new Map()
        for (const resource of [...(agents ?? []), ...(teams ?? [])]) {
          resourcesById.set(resource.id, resource)
        }

        setState({
          data: {
            capabilities,
            overview,
            runs: pageItems(runPage).map((run) => ({
              ...run,
              resource: resourcesById.get(run.resource_id),
            })),
            threads: pageItems(threadPage).map((thread) => ({
              ...thread,
              resource: resourcesById.get(thread.resource_id),
            })),
          },
          error: null,
          loading: false,
        })
      } catch (error) {
        if (error.name === 'AbortError') return

        setState({
          data: null,
          error,
          loading: false,
        })
      }
    }

    loadDashboard()
    return () => controller.abort()
  }, [api, reloadKey])

  return { ...state, reload }
}
