import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AGENT_TEMPLATES } from '../features/templates/agentTemplates'
import { TEAM_TEMPLATES } from '../features/templates/teamTemplates'
import { useApiClient } from '../hooks/useApiClient'

function TemplateCard({ children, description, icon, title }) {
  return (
    <article className="flex min-h-72 flex-col rounded-3xl border border-white/[0.08] bg-white/[0.022] p-6 transition-colors hover:border-white/[0.15] hover:bg-white/[0.035]">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/35 text-content-secondary">
        <span aria-hidden="true" className="material-symbols-outlined text-[20px]">{icon}</span>
      </span>
      <h3 className="mt-6 font-headline text-xl font-semibold text-white">{title}</h3>
      <p className="mt-3 flex-1 text-sm leading-6 text-content-supporting">{description}</p>
      {children}
    </article>
  )
}

function TeamTemplateCard({ agents, onLaunch, template }) {
  const [assignments, setAssignments] = useState({})
  const selectedIds = Object.values(assignments)
  const complete = template.slots.every((slot) => assignments[slot.id])
    && new Set(selectedIds).size === template.slots.length

  return (
    <TemplateCard description={template.description} icon={template.icon} title={template.name}>
      <div className="mt-5 space-y-3">
        {template.slots.map((slot) => (
          <label key={slot.id} className="block">
            <span className="mb-1.5 flex items-center justify-between text-[11px] text-content-secondary">
              <span>{slot.label}</span>
              <span className="text-content-muted">{slot.description}</span>
            </span>
            <select
              value={assignments[slot.id] || ''}
              onChange={(event) => setAssignments((current) => ({ ...current, [slot.id]: event.target.value }))}
              className="agent-input"
            >
              <option value="">Choose an Agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id} disabled={selectedIds.includes(agent.id) && assignments[slot.id] !== agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button type="button" onClick={() => onLaunch(template.id, assignments)} disabled={!complete} className="agent-primary-button mt-6 w-full">
        Open in Team Forge
      </button>
    </TemplateCard>
  )
}

export default function TemplateLibraryPage() {
  const api = useApiClient()
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const [state, setState] = useState({ agents: [], error: null, loading: true, tools: [] })

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      api.get('/agents', { signal: controller.signal }),
      api.get('/tools', { signal: controller.signal }),
    ]).then(([agents, tools]) => {
      setState({
        agents: Array.isArray(agents) ? agents : [],
        error: null,
        loading: false,
        tools: Array.isArray(tools) ? tools : [],
      })
    }).catch((error) => {
      if (error.name !== 'AbortError') setState({ agents: [], error, loading: false, tools: [] })
    })
    return () => controller.abort()
  }, [api])

  const preview = useMemo(() => ({ agents: state.agents, selectedId: null, teams: [], tools: state.tools }), [state.agents, state.tools])

  if (state.loading) {
    return <section className="mx-auto h-[620px] w-full max-w-[1600px] animate-pulse rounded-3xl bg-white/[0.035]" aria-label="Loading templates" />
  }

  if (state.error) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center text-center" role="alert">
        <div className="max-w-md">
          <h1 className="font-headline text-3xl font-semibold text-white">Templates could not be loaded</h1>
          <p className="mt-4 text-sm leading-6 text-content-supporting">{state.error.message}</p>
        </div>
      </section>
    )
  }

  return (
    <motion.section
      className="mx-auto w-full max-w-[1600px] pb-28"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="border-b border-white/[0.07] pb-9">
        <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.3em] text-content-supporting">Built-in starting points</p>
        <h1 className="mt-3 font-headline text-5xl font-semibold uppercase tracking-tight text-white">Templates</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-content-supporting">
          Start with a useful responsibility or delegation shape, then make it yours in Forge. Templates never choose a model or provider for you, and they do not create hidden resources.
        </p>
      </header>

      <section className="mt-10" aria-labelledby="agent-template-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-muted">Individual intelligence</p>
            <h2 id="agent-template-heading" className="mt-2 font-headline text-2xl font-semibold text-white">Agent templates</h2>
          </div>
          <span className="text-xs text-content-muted">Model selection remains yours</span>
        </div>
        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          {AGENT_TEMPLATES.map((template) => (
            <TemplateCard key={template.id} description={template.description} icon={template.icon} title={template.name}>
              <p className="mt-5 text-[11px] leading-5 text-content-muted">Prefills identity, directive, and available capability intent.</p>
              <button
                type="button"
                className="agent-primary-button mt-6 w-full"
                onClick={() => navigate('/agents/new?panel=agent&tab=overview', {
                  state: {
                    agentTemplateId: template.id,
                    createPreview: true,
                    mcpServersPreview: [],
                    toolsPreview: state.tools,
                  },
                })}
              >
                Open in Agent Forge
              </button>
            </TemplateCard>
          ))}
        </div>
      </section>

      <section className="mt-14" aria-labelledby="team-template-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-muted">Directed collaboration</p>
            <h2 id="team-template-heading" className="mt-2 font-headline text-2xl font-semibold text-white">Team templates</h2>
          </div>
          <span className="text-xs text-content-muted">Map existing Agents into every role</span>
        </div>
        {state.agents.length < 3 ? (
          <div className="mt-6 rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-8">
            <h3 className="font-headline text-lg font-semibold text-white">Create at least three Agents first</h3>
            <p className="mt-2 text-sm leading-6 text-content-supporting">A Team template references reusable Agents; it does not silently duplicate them. You currently have {state.agents.length}.</p>
            <button type="button" onClick={() => navigate('/agents/new')} className="agent-secondary-button mt-5">Create an Agent</button>
          </div>
        ) : (
          <div className="mt-6 grid gap-5 xl:grid-cols-2">
            {TEAM_TEMPLATES.map((template) => (
              <TeamTemplateCard
                key={template.id}
                agents={state.agents}
                template={template}
                onLaunch={(teamTemplateId, teamTemplateAssignments) => navigate('/teams/new', {
                  state: {
                    agentsPreview: state.agents,
                    createPreview: true,
                    libraryPreview: preview,
                    teamTemplateAssignments,
                    teamTemplateId,
                    toolsPreview: state.tools,
                  },
                })}
              />
            ))}
          </div>
        )}
      </section>
    </motion.section>
  )
}
