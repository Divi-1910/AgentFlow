import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from './useApiClient'

const initialState = {
  agents: [],
  error: null,
  loading: true,
  teams: [],
  tools: [],
}

export function useTeamLibrary() {
  const api = useApiClient()
  const [state, setState] = useState(initialState)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    async function loadLibrary() {
      setState((current) => ({ ...current, error: null, loading: true }))
      try {
        const [teams, agents, tools] = await Promise.all([
          api.get('/agent-teams', { signal: controller.signal }),
          api.get('/agents', { signal: controller.signal }),
          api.get('/tools', { signal: controller.signal }),
        ])
        setState({
          agents: Array.isArray(agents) ? agents : [],
          error: null,
          loading: false,
          teams: Array.isArray(teams) ? teams : [],
          tools: Array.isArray(tools) ? tools : [],
        })
      } catch (error) {
        if (error.name === 'AbortError') return
        setState({ ...initialState, error, loading: false })
      }
    }
    loadLibrary()
    return () => controller.abort()
  }, [api, reloadKey])

  return { ...state, reload }
}
