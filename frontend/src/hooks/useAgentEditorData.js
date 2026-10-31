import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from './useApiClient'

const initialState = {
  agent: null,
  error: null,
  loading: true,
  mcpServers: [],
  models: [],
  tools: [],
}

export function useAgentEditorData(agentId) {
  const api = useApiClient()
  const [state, setState] = useState(initialState)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey((currentKey) => currentKey + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadEditor() {
      setState((currentState) => ({
        ...currentState,
        error: null,
        loading: true,
      }))

      try {
        const [models, tools, mcpServers, agent] = await Promise.all([
          api.get('/llms', { signal: controller.signal }),
          api.get('/tools', { signal: controller.signal }),
          api.get('/mcp-servers', { signal: controller.signal }),
          agentId
            ? api.get(`/agents/${agentId}`, { signal: controller.signal })
            : Promise.resolve(null),
        ])

        setState({
          agent,
          error: null,
          loading: false,
          mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
          models: Array.isArray(models) ? models : [],
          tools: Array.isArray(tools) ? tools : [],
        })
      } catch (error) {
        if (error.name === 'AbortError') return
        setState({ ...initialState, error, loading: false })
      }
    }

    loadEditor()
    return () => controller.abort()
  }, [agentId, api, reloadKey])

  return { ...state, reload }
}
