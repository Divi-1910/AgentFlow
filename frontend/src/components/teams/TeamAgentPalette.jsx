import { useDeferredValue, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import useTeamCanvasPanelInset from './useTeamCanvasPanelInset'

export default function TeamAgentPalette({ agents, draft, onAddAgent, onCanvasInsetChange, onClose, returning = false }) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const panelRef = useTeamCanvasPanelInset('left', onCanvasInsetChange)
  const usedIds = useMemo(() => new Set(draft.nodes.map((node) => node.agent_id)), [draft.nodes])
  const availableAgents = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    return agents.filter((agent) => {
      if (usedIds.has(agent.id)) return false
      if (!normalized) return true
      return [agent.name, agent.description, agent.provider, agent.model]
        .some((value) => String(value || '').toLowerCase().includes(normalized))
    })
  }, [agents, deferredQuery, usedIds])

  return (
    <motion.aside
      ref={panelRef}
      className="team-agent-palette"
      aria-label="Agent palette"
      initial={{ opacity: 0, x: 'calc(-100% - 2rem)' }}
      animate={returning
        ? { opacity: 0, x: 'calc(-100% - 2rem)' }
        : { opacity: 1, x: 0 }}
      transition={{ duration: 0.27, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="team-panel-heading">
        <div>
          <span>Add Agents</span>
          <p>Choose reusable Agents for this Team. Connect them on the canvas when they need to delegate.</p>
        </div>
        <button type="button" className="team-panel-close" onClick={onClose} aria-label="Close Agent catalog">
          <span aria-hidden="true" className="material-symbols-outlined">close</span>
        </button>
      </div>
      <label htmlFor="team-agent-search" className="sr-only">Search available agents</label>
      <div className="team-library-search">
        <span aria-hidden="true" className="material-symbols-outlined">search</span>
        <input
          id="team-agent-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search agents"
        />
      </div>
      <div className="team-agent-palette__list">
        {availableAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="team-palette-agent"
            draggable
            onClick={() => onAddAgent(agent.id)}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/agentflow-agent', agent.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
          >
            <span aria-hidden="true" className="material-symbols-outlined">smart_toy</span>
            <span>
              <strong>{agent.name}</strong>
              <small>{agent.description || 'No Agent description has been added.'}</small>
              <em>{agent.provider} · {agent.model}</em>
            </span>
            <i aria-hidden="true" className="material-symbols-outlined">add</i>
          </button>
        ))}
        {availableAgents.length === 0 ? (
          <p className="team-agent-palette__empty">
            {agents.length === usedIds.size ? 'Every available Agent is already part of this Team.' : 'No Agents match this search.'}
          </p>
        ) : null}
      </div>
      <footer>{draft.nodes.length} in Team · {draft.edges.length} delegation {draft.edges.length === 1 ? 'route' : 'routes'}</footer>
    </motion.aside>
  )
}
