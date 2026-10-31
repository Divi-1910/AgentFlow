import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from './useApiClient'

const initialState = {
  agents: [],
  error: null,
  loading: true,
  mcpServers: [],
  tools: [],
}

export function useAgentLibrary() {
  const api = useApiClient()
  const [state, setState] = useState(initialState)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey((currentKey) => currentKey + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadAgents() {
      setState((currentState) => ({
        ...currentState,
        error: null,
        loading: true,
      }))

      try {
        const [agents, mcpServers, tools] = await Promise.all([
          api.get('/agents', { signal: controller.signal }),
          api.get('/mcp-servers', { signal: controller.signal }),
          api.get('/tools', { signal: controller.signal }),
        ])
        setState({
          agents: Array.isArray(agents) ? agents : [],
          error: null,
          loading: false,
          mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
          tools: Array.isArray(tools) ? tools : [],
        })
      } catch (error) {
        if (error.name === 'AbortError') return
        setState({ agents: [], error, loading: false, mcpServers: [], tools: [] })
      }
    }

    loadAgents()
    return () => controller.abort()
  }, [api, reloadKey])

  return { ...state, reload }
}
