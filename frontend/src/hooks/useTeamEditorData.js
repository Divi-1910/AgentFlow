import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from './useApiClient'

const initialState = { agents: [], error: null, loading: true, team: null, tools: [] }

export function useTeamEditorData(teamId) {
  const api = useApiClient()
  const [state, setState] = useState(initialState)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    async function loadEditor() {
      setState((current) => ({ ...current, error: null, loading: true }))
      try {
        const [agents, tools, team] = await Promise.all([
          api.get('/agents', { signal: controller.signal }),
          api.get('/tools', { signal: controller.signal }),
          teamId ? api.get(`/agent-teams/${teamId}`, { signal: controller.signal }) : Promise.resolve(null),
        ])
        setState({
          agents: Array.isArray(agents) ? agents : [],
          error: null,
          loading: false,
          team,
          tools: Array.isArray(tools) ? tools : [],
        })
      } catch (error) {
        if (error.name === 'AbortError') return
        setState({ ...initialState, error, loading: false })
      }
    }
    loadEditor()
    return () => controller.abort()
  }, [api, reloadKey, teamId])

  return { ...state, reload }
}
