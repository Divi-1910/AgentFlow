import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import AgentInspector from '../components/agents/AgentInspector'
import { fieldId } from '../features/agents/agentFieldIds'
import {
  agentToForm,
  buildAgentPatch,
  buildCreateAgentPayload,
  hasCreateChanges,
  validateAgentForm,
} from '../features/agents/agentForm'
import { agentEditorTabs, tabForAgentField } from '../features/agents/agentForgeGraph'
import { createAgentTemplateForm } from '../features/templates/agentTemplates'
import { useAgentEditorData } from '../hooks/useAgentEditorData'
import { useApiClient } from '../hooks/useApiClient'

function mergeSelectedTools(catalog, selected) {
  const entries = [...catalog]
  const names = new Set(entries.map((tool) => tool.name))
  for (const name of selected) {
    if (!names.has(name)) {
      entries.push({ name, description: 'This saved tool is no longer present in the current catalog.', available: false })
    }
  }
  return entries
}

function mergeSelectedMcpServers(catalog, selected) {
  const entries = [...catalog]
  const ids = new Set(entries.map((server) => server.server_id))
  for (const serverId of selected) {
    if (!ids.has(serverId)) {
      entries.push({
        server_id: serverId,
        name: serverId.replaceAll('-', ' '),
        description: 'This saved MCP server is no longer enabled in the current catalog.',
        unavailable: true,
      })
    }
  }
  return entries
}

function backendErrorField(message) {
  const normalized = String(message || '').toLowerCase()
  if (normalized.includes('system_prompt')) return 'system_prompt'
  if (normalized.includes('summarization_model')) return 'summarization_model'
  if (normalized.includes('context_window')) return 'context_window'
  if (normalized.includes('context_keep_ratio')) return 'context_keep_ratio'
  if (normalized.includes('max_steps')) return 'max_steps'
  if (normalized.includes('max_tokens')) return 'max_tokens'
  if (normalized.includes('max_runs')) return 'max_runs'
  if (normalized.includes('temperature')) return 'temperature'
  if (normalized.includes('mcp')) return 'mcp_servers'
  if (normalized.includes('tool')) return 'tools'
  if (normalized.includes('provider')) return 'provider'
  if (normalized.includes('model')) return 'model'
  if (normalized.includes('name')) return 'name'
  return 'form'
}

function mergeAgentIntoLibraryPreview(preview, savedAgent, catalogs) {
  const currentPreview = preview && Array.isArray(preview.agents)
    ? preview
    : {
        agents: [],
        mcpServers: catalogs.mcpServers,
        selectedId: null,
        tools: catalogs.tools,
      }

  const existingIndex = currentPreview.agents.findIndex((agent) => agent.id === savedAgent.id)
  const agents = existingIndex === -1
    ? [...currentPreview.agents, savedAgent]
    : currentPreview.agents.map((agent, index) => (index === existingIndex ? savedAgent : agent))

  return {
    ...currentPreview,
    agents,
    selectedId: savedAgent.id,
  }
}

function AgentEditorLoading() {
  return (
    <section aria-label="Loading agent editor" className="agent-workspace-route-state animate-pulse">
      <div className="mb-7 h-24 rounded-2xl bg-white/[0.04]" />
      <div className="h-[calc(100vh-16rem)] min-h-[620px] rounded-[2rem] border border-white/[0.05] bg-white/[0.025]" />
    </section>
  )
}

function AgentEditorError({ error, onRetry }) {
  return (
    <section className="agent-workspace-route-state flex items-center justify-center text-center" role="alert">
      <div className="max-w-md">
        <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.24em] text-red-300/70">Configuration unavailable</p>
        <h1 className="mt-4 font-headline text-3xl font-semibold text-white">The Agent Forge could not be loaded</h1>
        <p className="mt-4 text-sm leading-6 text-white/50">{error?.message || 'AgentFlow could not load this configuration.'}</p>
        <button type="button" onClick={onRetry} className="agent-primary-button mt-7">Retry connection</button>
      </div>
    </section>
  )
}

export default function AgentEditorPage() {
  const { agentId } = useParams()
  const isCreate = !agentId
  const location = useLocation()
  const navigate = useNavigate()
  const { publishCanvasPresentation } = useOutletContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const api = useApiClient()
  const { agent, error, loading, mcpServers, models, reload, tools } = useAgentEditorData(agentId)
  const routeAgentPreview = !isCreate && location.state?.agentPreview?.id === agentId
    ? location.state.agentPreview
    : null
  const routeCreatePreview = isCreate && location.state?.createPreview === true
  const routeTemplateId = isCreate ? location.state?.agentTemplateId : null
  const hasRoutePreview = Boolean(routeAgentPreview || routeCreatePreview)
  const routeMcpPreview = hasRoutePreview && Array.isArray(location.state?.mcpServersPreview)
    ? location.state.mcpServersPreview
    : []
  const routeToolsPreview = hasRoutePreview && Array.isArray(location.state?.toolsPreview)
    ? location.state.toolsPreview
    : []
  const returnLibraryPreviewRef = useRef(location.state?.libraryPreview)
  const previewing = loading && hasRoutePreview
  const [form, setForm] = useState(() => agentToForm(routeAgentPreview))
  const [originalAgent, setOriginalAgent] = useState(routeAgentPreview)
  const [initializedFor, setInitializedFor] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)
  const [pendingFocusField, setPendingFocusField] = useState(null)
  const [returningToLibrary, setReturningToLibrary] = useState(false)
  const editorLocked = previewing || (!isCreate && initializedFor !== agentId)

  const inspectorOpen = searchParams.get('panel') === 'agent'
  const requestedTab = searchParams.get('tab')
  const activeTab = agentEditorTabs.includes(requestedTab) ? requestedTab : 'overview'

  const openInspector = useCallback((tab = 'overview') => {
    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams)
      nextParams.set('panel', 'agent')
      nextParams.set('tab', agentEditorTabs.includes(tab) ? tab : 'overview')
      return nextParams
    }, { replace: true })
  }, [setSearchParams])

  const openAgentInspector = useCallback(() => {
    openInspector('overview')
  }, [openInspector])

  const closeInspector = useCallback(() => {
    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams)
      nextParams.delete('panel')
      nextParams.delete('tab')
      return nextParams
    }, { replace: true })
    window.requestAnimationFrame(() => {
      document.querySelector('[data-agent-core-trigger]')?.focus()
    })
  }, [setSearchParams])

  useEffect(() => {
    if (loading) return
    const identity = agentId || 'new'
    if (initializedFor === identity) return
    setForm(routeTemplateId ? createAgentTemplateForm(routeTemplateId, tools) : agentToForm(agent))
    setOriginalAgent(agent)
    setInitializedFor(identity)
  }, [agent, agentId, initializedFor, loading, routeTemplateId, tools])

  const patch = useMemo(
    () => (isCreate ? {} : buildAgentPatch(form, originalAgent)),
    [form, isCreate, originalAgent],
  )
  const dirty = isCreate ? hasCreateChanges(form) : Object.keys(patch).length > 0

  useEffect(() => {
    if (!dirty) return undefined

    const onBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const onLinkClick = (event) => {
      const anchor = event.target.closest?.('a[href]')
      if (!anchor || anchor.target === '_blank' || event.defaultPrevented) return
      if (!window.confirm('Discard the unsaved changes to this agent?')) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onLinkClick, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onLinkClick, true)
    }
  }, [dirty])

  useEffect(() => {
    if (!inspectorOpen || !pendingFocusField) return undefined
    const frame = window.requestAnimationFrame(() => {
      const field = document.getElementById(fieldId(pendingFocusField))
      if (!field) return
      field.focus()
      setPendingFocusField(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTab, inspectorOpen, pendingFocusField])

  const providers = useMemo(() => {
    const values = new Set(models.filter((model) => model.available).map((model) => model.provider))
    if (originalAgent?.provider) values.add(originalAgent.provider)
    return [...values].sort()
  }, [models, originalAgent])

  const providerModels = useMemo(() => {
    const result = models.filter((model) => model.provider === form.provider && model.available)
    if (originalAgent?.provider === form.provider && originalAgent?.model && !result.some((model) => model.api_model_id === originalAgent.model)) {
      result.push({
        api_model_id: originalAgent.model,
        available: false,
        name: originalAgent.model,
        provider: originalAgent.provider,
      })
    }
    return result
  }, [form.provider, models, originalAgent])

  const visibleTools = previewing ? routeToolsPreview : tools
  const visibleMcpServers = previewing ? routeMcpPreview : mcpServers
  const toolChoices = useMemo(() => mergeSelectedTools(visibleTools, form.tools), [form.tools, visibleTools])
  const mcpChoices = useMemo(
    () => mergeSelectedMcpServers(visibleMcpServers, form.mcp_server_ids),
    [form.mcp_server_ids, visibleMcpServers],
  )

  useLayoutEffect(() => {
    publishCanvasPresentation({
      dirty,
      form,
      identity: agentId || 'new-agent',
      inspectorOpen,
      interactionDisabled: editorLocked,
      mcpChoices,
      mode: 'forge',
      onOpenInspector: openAgentInspector,
      panelPlacement: returningToLibrary
        ? 'library'
        : inspectorOpen
          ? 'inspector'
          : 'none',
      preserveViewport: routeCreatePreview,
      toolChoices,
    })
  }, [
    agentId,
    dirty,
    editorLocked,
    form,
    inspectorOpen,
    mcpChoices,
    openAgentInspector,
    publishCanvasPresentation,
    returningToLibrary,
    routeCreatePreview,
    toolChoices,
  ])

  function setField(field, value) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }))
    setFieldErrors((currentErrors) => {
      if (!currentErrors[field] && !currentErrors.form) return currentErrors
      const nextErrors = { ...currentErrors }
      delete nextErrors[field]
      delete nextErrors.form
      if (field === 'mcp_server_ids') delete nextErrors.mcp_servers
      return nextErrors
    })
    setNotice(null)
  }

  function changeProvider(provider) {
    const modelStillMatches = models.some((model) => (
      model.provider === provider && model.api_model_id === form.model && model.available
    ))
    setForm((currentForm) => ({
      ...currentForm,
      provider,
      model: modelStillMatches ? currentForm.model : '',
      summarization_model: '',
    }))
    setFieldErrors((currentErrors) => ({ ...currentErrors, provider: undefined, model: undefined }))
    setNotice(null)
  }

  function leaveEditor() {
    if (returningToLibrary) return
    if (dirty && !window.confirm('Discard the unsaved changes to this agent?')) return
    setReturningToLibrary(true)
  }

  const completeReturnToLibrary = useCallback(() => {
    if (!returningToLibrary) return
    navigate('/agents', {
      state: {
        animateLibraryEntry: true,
        libraryPreview: returnLibraryPreviewRef.current,
      },
    })
  }, [navigate, returningToLibrary])

  useEffect(() => {
    if (!returningToLibrary || inspectorOpen) return undefined
    const frame = window.requestAnimationFrame(completeReturnToLibrary)
    return () => window.cancelAnimationFrame(frame)
  }, [completeReturnToLibrary, inspectorOpen, returningToLibrary])

  function revealError(field) {
    if (field === 'form') return
    openInspector(tabForAgentField(field))
    setPendingFocusField(field === 'mcp_servers' ? 'mcp_server_ids' : field)
  }

  async function saveAgent(event) {
    event.preventDefault()
    if (editorLocked) return
    const validationErrors = validateAgentForm(form, { requireRuntimeValues: !isCreate })
    if (Object.keys(validationErrors).length > 0) {
      const firstField = Object.keys(validationErrors)[0]
      setFieldErrors(validationErrors)
      setNotice(null)
      revealError(firstField)
      return
    }

    if (!isCreate && Object.keys(patch).length === 0) return

    setSaving(true)
    setFieldErrors({})
    setNotice(null)
    try {
      const savedAgent = isCreate
        ? await api.post('/agents', buildCreateAgentPayload(form))
        : await api.patch(`/agents/${agentId}`, patch)

      setOriginalAgent(savedAgent)
      setForm(agentToForm(savedAgent))
      setNotice(isCreate ? 'Agent created.' : 'Changes saved.')
      const nextLibraryPreview = mergeAgentIntoLibraryPreview(returnLibraryPreviewRef.current, savedAgent, {
        mcpServers: visibleMcpServers,
        tools: visibleTools,
      })
      returnLibraryPreviewRef.current = nextLibraryPreview

      if (isCreate) {
        setReturningToLibrary(true)
      }
    } catch (saveError) {
      const message = saveError.message || 'The agent could not be saved.'
      const field = backendErrorField(message)
      setFieldErrors({ [field]: message })
      revealError(field)
    } finally {
      setSaving(false)
    }
  }

  if (loading && !hasRoutePreview) return <AgentEditorLoading />
  if (error) return <AgentEditorError error={error} onRetry={reload} />

  return (
    <form onSubmit={saveAgent} className="agent-forge-overlay" noValidate>
      <header className="agent-forge-header">
        <div className="agent-forge-header__identity">
          <button
            type="button"
            onClick={leaveEditor}
            disabled={returningToLibrary}
            className="agent-icon-button"
            aria-label="Back to agent library"
          >
            <span aria-hidden="true" className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="min-w-0">
            <p>Agent Forge <span>/</span> {isCreate ? 'New intelligence' : 'Edit intelligence'}</p>
            <h1>{form.name || (isCreate ? 'New agent' : 'Untitled agent')}</h1>
          </div>
        </div>

        <div className="agent-forge-header__actions">
          <div className="agent-forge-save-state" aria-live="polite">
            {notice ? <span className="is-saved">{notice}</span> : null}
            {!notice && dirty ? <span className="is-dirty"><i aria-hidden="true" /> Unsaved draft</span> : null}
            {!notice && !dirty && !isCreate ? <span>All changes saved</span> : null}
          </div>
          <button
            type="submit"
            disabled={returningToLibrary || editorLocked || saving || (!isCreate && !dirty)}
            className="agent-primary-button"
            aria-busy={saving}
          >
            <span aria-hidden="true" className="material-symbols-outlined">save</span>
            {saving ? 'Saving…' : isCreate ? 'Create agent' : 'Save changes'}
          </button>
        </div>
      </header>

      {fieldErrors.form ? (
        <div className="agent-forge-form-error" role="alert">{fieldErrors.form}</div>
      ) : null}

      <AnimatePresence onExitComplete={completeReturnToLibrary}>
        {inspectorOpen && !returningToLibrary ? (
          <AgentInspector
            activeTab={activeTab}
            changeProvider={changeProvider}
            fieldErrors={fieldErrors}
            form={form}
            mcpChoices={mcpChoices}
            onClose={closeInspector}
            onTabChange={openInspector}
            providerModels={providerModels}
            providers={providers}
            setField={setField}
            toolChoices={toolChoices}
          />
        ) : null}
      </AnimatePresence>
    </form>
  )
}
