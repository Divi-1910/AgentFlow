import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  agentEditorTabs,
  agentToolGroups,
  getAgentReadiness,
  getToolGroupSelection,
  isGroupedAgentTool,
  toggleToolGroup,
} from '../../features/agents/agentForgeGraph'
import { fieldId } from '../../features/agents/agentFieldIds'
import { toggleSelection } from '../../features/agents/agentForm'

const tabLabels = {
  capabilities: 'Capabilities',
  instructions: 'Instructions',
  model: 'Model',
  overview: 'Overview',
  runtime: 'Runtime',
}

const inputClassName = 'agent-input mt-2'

function FieldError({ field, message }) {
  return message ? (
    <p id={`${fieldId(field)}-error`} className="mt-2 text-xs leading-5 text-red-300" role="alert">
      {message}
    </p>
  ) : null
}

function TextField({ error, field, label, ...inputProps }) {
  const id = fieldId(field)
  return (
    <div>
      <label htmlFor={id} className="agent-field-label">{label}</label>
      <input
        id={id}
        name={field}
        className={inputClassName}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        {...inputProps}
      />
      <FieldError field={field} message={error} />
    </div>
  )
}

function SelectField({ children, error, field, label, ...selectProps }) {
  const id = fieldId(field)
  return (
    <div>
      <label htmlFor={id} className="agent-field-label">{label}</label>
      <select
        id={id}
        name={field}
        className={inputClassName}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={Boolean(error)}
        {...selectProps}
      >
        {children}
      </select>
      <FieldError field={field} message={error} />
    </div>
  )
}

function InspectorHeading({ children, detail }) {
  return (
    <div className="agent-inspector__section-heading">
      <h3>{children}</h3>
      {detail ? <p>{detail}</p> : null}
    </div>
  )
}

function OverviewPanel({ fieldErrors, form, setField }) {
  const readiness = getAgentReadiness(form)
  const requirements = [
    ['name', 'Identity named'],
    ['provider', 'Provider selected'],
    ['model', 'Model selected'],
    ['system_prompt', 'Directive written'],
  ]

  return (
    <div className="agent-inspector__panel-stack">
      <section>
        <InspectorHeading detail="The human-readable identity shown throughout AgentFlow.">Identity</InspectorHeading>
        <div className="space-y-5">
          <TextField
            field="name"
            label="Name"
            value={form.name}
            error={fieldErrors.name}
            onChange={(event) => setField('name', event.target.value)}
            placeholder="Research Analyst"
          />
          <div>
            <label htmlFor={fieldId('description')} className="agent-field-label">Description</label>
            <textarea
              id={fieldId('description')}
              name="description"
              value={form.description}
              onChange={(event) => setField('description', event.target.value)}
              className={`${inputClassName} min-h-28 resize-y leading-6`}
              placeholder="What is this agent responsible for?"
            />
          </div>
        </div>
      </section>

      <section className="agent-readiness-card" aria-label={`${readiness.completed} of ${readiness.total} essential fields configured`}>
        <div className="agent-readiness-card__header">
          <div>
            <span>Launch readiness</span>
            <strong>{readiness.percent}%</strong>
          </div>
          <span className={readiness.ready ? 'is-ready' : ''}>{readiness.ready ? 'Ready' : 'In progress'}</span>
        </div>
        <div className="agent-readiness-card__track" aria-hidden="true">
          <span style={{ width: `${readiness.percent}%` }} />
        </div>
        <ul>
          {requirements.map(([field, label]) => {
            const complete = String(form[field] || '').trim().length > 0
            return (
              <li key={field} className={complete ? 'is-complete' : ''}>
                <span className="material-symbols-outlined" aria-hidden="true">
                  {complete ? 'check_circle' : 'radio_button_unchecked'}
                </span>
                {label}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

function InstructionsPanel({ fieldErrors, form, setField }) {
  const words = String(form.system_prompt || '').trim().split(/\s+/).filter(Boolean).length
  return (
    <section>
      <InspectorHeading detail="Define how the agent reasons, behaves, uses tools, and stays within its boundaries.">
        System directive
      </InspectorHeading>
      <label htmlFor={fieldId('system_prompt')} className="sr-only">System prompt</label>
      <textarea
        id={fieldId('system_prompt')}
        name="system_prompt"
        value={form.system_prompt}
        onChange={(event) => setField('system_prompt', event.target.value)}
        aria-describedby={fieldErrors.system_prompt ? `${fieldId('system_prompt')}-error` : 'system-prompt-guidance'}
        aria-invalid={Boolean(fieldErrors.system_prompt)}
        className="agent-prompt-editor agent-prompt-editor--inspector"
        placeholder="You are a research analyst responsible for…"
        spellCheck="true"
      />
      <div id="system-prompt-guidance" className="agent-prompt-meta">
        <span>{words} words</span>
        <span>Role · Goals · Policy · Boundaries</span>
      </div>
      <FieldError field="system_prompt" message={fieldErrors.system_prompt} />
    </section>
  )
}

function ModelPanel({ changeProvider, fieldErrors, form, providerModels, providers, setField }) {
  return (
    <section>
      <InspectorHeading detail="AgentFlow supplies provider credentials. Choose the intelligence profile this agent will use.">
        Intelligence
      </InspectorHeading>
      <div className="space-y-5">
        <SelectField
          field="provider"
          label="Provider"
          value={form.provider}
          error={fieldErrors.provider}
          onChange={(event) => changeProvider(event.target.value)}
        >
          <option value="">Select provider</option>
          {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </SelectField>
        <SelectField
          field="model"
          label="Primary model"
          value={form.model}
          error={fieldErrors.model}
          disabled={!form.provider}
          onChange={(event) => setField('model', event.target.value)}
        >
          <option value="">Select model</option>
          {providerModels.map((model) => (
            <option key={model.api_model_id} value={model.api_model_id}>
              {model.name} · {model.api_model_id}{model.available ? '' : ' (currently unavailable)'}
            </option>
          ))}
        </SelectField>
        <SelectField
          field="summarization_model"
          label="Summarization model"
          value={form.summarization_model}
          error={fieldErrors.summarization_model}
          disabled={!form.provider}
          onChange={(event) => setField('summarization_model', event.target.value)}
        >
          <option value="">Use the primary model</option>
          {providerModels.map((model) => (
            <option key={model.api_model_id} value={model.api_model_id}>
              {model.name} · {model.api_model_id}
            </option>
          ))}
        </SelectField>
      </div>
    </section>
  )
}

function CapabilityOption({ checked, description, disabled, icon, indeterminate = false, label, meta, name, onChange, tone }) {
  const inputRef = useRef(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  const active = checked || indeterminate

  return (
    <label className={`agent-capability-option ${active ? 'is-selected' : ''} ${indeterminate ? 'is-partial' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <span className="agent-capability-option__icon material-symbols-outlined" aria-hidden="true">
        {icon || (tone === 'mcp' ? 'lan' : 'extension')}
      </span>
      <span className="agent-capability-option__copy">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      {meta ? <span className="agent-capability-option__meta">{meta}</span> : null}
      <input
        ref={inputRef}
        type="checkbox"
        name={name}
        checked={checked}
        aria-checked={indeterminate ? 'mixed' : checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="agent-capability-option__check material-symbols-outlined" aria-hidden="true">
        {indeterminate ? 'remove' : checked ? 'check' : ''}
      </span>
    </label>
  )
}

function CapabilitiesPanel({ fieldErrors, form, mcpChoices, setField, toolChoices }) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const toolChoicesByName = useMemo(
    () => new Map(toolChoices.map((tool) => [tool.name, tool])),
    [toolChoices],
  )
  const visibleGroups = useMemo(
    () => agentToolGroups.filter((group) => (
      `${group.label} ${group.description} ${group.tools.join(' ')}`.toLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery],
  )
  const visibleTools = useMemo(
    () => toolChoices.filter((tool) => (
      !isGroupedAgentTool(tool.name)
      && `${tool.name} ${tool.description || ''}`.toLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery, toolChoices],
  )
  const visibleMcp = useMemo(
    () => mcpChoices.filter((server) => `${server.name} ${server.description || ''}`.toLowerCase().includes(normalizedQuery)),
    [mcpChoices, normalizedQuery],
  )
  const selectedGroupCount = agentToolGroups.filter((group) => (
    getToolGroupSelection(form.tools, group.tools).state !== 'none'
  )).length
  const selectedStandaloneCount = form.tools.filter((toolName) => !isGroupedAgentTool(toolName)).length
  const selectedCapabilityCount = selectedGroupCount + selectedStandaloneCount + form.mcp_server_ids.length

  return (
    <div className="agent-inspector__panel-stack">
      <section>
        <InspectorHeading detail="Attach runtime tools and independently hosted MCP services.">Capability matrix</InspectorHeading>
        <div className="agent-capability-search">
          <span className="material-symbols-outlined" aria-hidden="true">search</span>
          <label htmlFor="capability-search" className="sr-only">Search capabilities</label>
          <input
            id="capability-search"
            name="capability_search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools and MCP servers"
            autoComplete="off"
          />
          <span>{selectedCapabilityCount} active</span>
        </div>
      </section>

      <section>
        <div className="agent-capability-group-heading">
          <h4>Core capabilities</h4>
          <span>Bundled operations</span>
        </div>
        <div className="agent-capability-options agent-capability-options--bundles">
          {visibleGroups.map((group) => {
            const selection = getToolGroupSelection(form.tools, group.tools)
            const unavailable = group.tools.some((toolName) => toolChoicesByName.get(toolName)?.available === false || !toolChoicesByName.has(toolName))
            const meta = selection.state === 'partial'
              ? `${selection.selectedCount} of ${selection.total} enabled${unavailable ? ' · catalog incomplete' : ''}`
              : selection.state === 'all'
                ? `${selection.total} operations enabled`
                : unavailable
                  ? 'Unavailable'
                  : `${selection.total} operations`

            return (
              <CapabilityOption
                key={group.id}
                checked={selection.state === 'all'}
                description={group.description}
                disabled={selection.state === 'none' && unavailable}
                icon={group.icon}
                indeterminate={selection.state === 'partial'}
                label={group.label}
                meta={meta}
                name={`tool-group-${group.id}`}
                tone="tool"
                onChange={() => {
                  const nextTools = unavailable && selection.state === 'partial'
                    ? form.tools.filter((toolName) => !group.tools.includes(toolName))
                    : toggleToolGroup(form.tools, group.tools)
                  setField('tools', nextTools)
                }}
              />
            )
          })}
          {visibleGroups.length === 0 ? <p className="agent-capability-empty-state">No matching core capabilities.</p> : null}
        </div>
      </section>

      <section>
        <div className="agent-capability-group-heading">
          <h4>Standalone tools</h4>
          <span>{selectedStandaloneCount} selected</span>
        </div>
        <div className="agent-capability-options">
          {visibleTools.map((tool) => {
            const selected = form.tools.includes(tool.name)
            return (
              <CapabilityOption
                key={tool.name}
                checked={selected}
                disabled={!tool.available && !selected}
                label={tool.name}
                description={tool.description}
                meta={tool.available ? null : 'Unavailable'}
                name={`tool-${tool.name}`}
                tone="tool"
                onChange={() => setField('tools', toggleSelection(form.tools, tool.name))}
              />
            )
          })}
          {visibleTools.length === 0 ? <p className="agent-capability-empty-state">No matching tools.</p> : null}
        </div>
        <FieldError field="tools" message={fieldErrors.tools} />
      </section>

      <section>
        <div className="agent-capability-group-heading">
          <h4>MCP servers</h4>
          <span>{form.mcp_server_ids.length} selected</span>
        </div>
        <div className="agent-capability-options">
          {visibleMcp.map((server) => {
            const selected = form.mcp_server_ids.includes(server.server_id)
            return (
              <CapabilityOption
                key={server.server_id}
                checked={selected}
                disabled={Boolean(server.unavailable) && !selected}
                label={server.name}
                description={server.description}
                meta={server.unavailable ? 'Unavailable' : null}
                name={`mcp-${server.server_id}`}
                tone="mcp"
                onChange={() => setField('mcp_server_ids', toggleSelection(form.mcp_server_ids, server.server_id))}
              />
            )
          })}
          {visibleMcp.length === 0 ? <p className="agent-capability-empty-state">No matching MCP servers.</p> : null}
        </div>
        <FieldError field="mcp_servers" message={fieldErrors.mcp_servers || fieldErrors.mcp_server_ids} />
      </section>
    </div>
  )
}

function RuntimePanel({ fieldErrors, form, setField }) {
  return (
    <section>
      <InspectorHeading detail="Bound the context, creativity, and work this agent may consume per task.">
        Execution envelope
      </InspectorHeading>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField field="context_window" label="Minimum recent turns" type="number" min="1" value={form.context_window} error={fieldErrors.context_window} onChange={(event) => setField('context_window', event.target.value)} placeholder="Default" />
        <TextField field="context_keep_ratio" label="Context keep ratio" type="number" min="0.01" max="1" step="0.01" value={form.context_keep_ratio} error={fieldErrors.context_keep_ratio} onChange={(event) => setField('context_keep_ratio', event.target.value)} placeholder="Default" />
        <TextField field="temperature" label="Temperature" type="number" min="0.01" max="1" step="0.01" value={form.temperature} error={fieldErrors.temperature} onChange={(event) => setField('temperature', event.target.value)} placeholder="Default" />
        <TextField field="max_steps" label="Maximum steps" type="number" min="1" value={form.max_steps} error={fieldErrors.max_steps} onChange={(event) => setField('max_steps', event.target.value)} placeholder="Default" />
        <TextField field="max_tokens" label="Maximum output tokens" type="number" min="1" value={form.max_tokens} error={fieldErrors.max_tokens} onChange={(event) => setField('max_tokens', event.target.value)} placeholder="Default" />
        <TextField field="max_runs" label="Maximum task runs" type="number" min="1" value={form.max_runs} error={fieldErrors.max_runs} onChange={(event) => setField('max_runs', event.target.value)} placeholder="Default" />
      </div>
    </section>
  )
}

export default function AgentInspector({
  activeTab,
  changeProvider,
  fieldErrors,
  form,
  mcpChoices,
  onClose,
  onTabChange,
  providerModels,
  providers,
  setField,
  toolChoices,
}) {
  const tabRefs = useRef([])
  const reduceMotion = useReducedMotion()

  function onTabKeyDown(event, index) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % agentEditorTabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + agentEditorTabs.length) % agentEditorTabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = agentEditorTabs.length - 1
    onTabChange(agentEditorTabs[nextIndex])
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <motion.aside
      className="agent-inspector"
      aria-label="Agent configuration inspector"
      initial={reduceMotion ? false : { opacity: 0.35, x: 'calc(100% + 2rem)' }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, x: 'calc(100% + 2rem)' }}
      transition={{ duration: reduceMotion ? 0 : 0.38, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="agent-inspector__header">
        <div>
          <span>Agent inspector</span>
          <h2>{form.name || 'Untitled agent'}</h2>
        </div>
        <button type="button" className="agent-icon-button" onClick={onClose} aria-label="Close agent inspector">
          <span className="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>

      <div className="agent-inspector__tabs" role="tablist" aria-label="Agent configuration sections">
        {agentEditorTabs.map((tab, index) => (
          <button
            key={tab}
            ref={(element) => { tabRefs.current[index] = element }}
            id={`agent-tab-${tab}`}
            type="button"
            role="tab"
            aria-controls={`agent-panel-${tab}`}
            aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      <div
        id={`agent-panel-${activeTab}`}
        className="agent-inspector__body"
        role="tabpanel"
        aria-labelledby={`agent-tab-${activeTab}`}
        tabIndex="0"
      >
        {activeTab === 'overview' ? <OverviewPanel fieldErrors={fieldErrors} form={form} setField={setField} /> : null}
        {activeTab === 'instructions' ? <InstructionsPanel fieldErrors={fieldErrors} form={form} setField={setField} /> : null}
        {activeTab === 'model' ? <ModelPanel changeProvider={changeProvider} fieldErrors={fieldErrors} form={form} providerModels={providerModels} providers={providers} setField={setField} /> : null}
        {activeTab === 'capabilities' ? <CapabilitiesPanel fieldErrors={fieldErrors} form={form} mcpChoices={mcpChoices} setField={setField} toolChoices={toolChoices} /> : null}
        {activeTab === 'runtime' ? <RuntimePanel fieldErrors={fieldErrors} form={form} setField={setField} /> : null}
      </div>
    </motion.aside>
  )
}
