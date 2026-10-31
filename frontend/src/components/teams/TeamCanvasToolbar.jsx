import { useDeferredValue, useMemo, useState } from 'react'

export default function TeamCanvasToolbar({
  agents,
  draft,
  mode,
  onFitGraph,
  onFocusAgent,
  onOpenCatalog,
  onOpenReview,
  onOpenTeam,
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const results = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    if (!normalized) return []
    return (draft.nodes || [])
      .map((node) => agentsById.get(node.agent_id))
      .filter(Boolean)
      .filter((agent) => [agent.name, agent.description, agent.provider, agent.model]
        .some((value) => String(value || '').toLowerCase().includes(normalized)))
      .slice(0, 6)
  }, [agentsById, deferredQuery, draft.nodes])

  return (
    <div className={`team-canvas-toolbar team-canvas-toolbar--${mode}`}>
      <div className="team-canvas-toolbar__search">
        <span aria-hidden="true" className="material-symbols-outlined">search</span>
        <label htmlFor={`team-canvas-search-${mode}`} className="sr-only">Find an Agent in this Team</label>
        <input
          id={`team-canvas-search-${mode}`}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find agent in graph"
        />
        {query ? (
          <button type="button" aria-label="Clear graph search" onClick={() => setQuery('')}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        ) : null}
        {query ? (
          <div className="team-canvas-toolbar__results">
            {results.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  onFocusAgent(agent.id)
                  setQuery('')
                }}
              >
                <span aria-hidden="true" className="material-symbols-outlined">smart_toy</span>
                <span><strong>{agent.name}</strong><small>{agent.provider} · {agent.model}</small></span>
              </button>
            ))}
            {results.length === 0 ? <p>No Agent in this graph matches “{deferredQuery}”.</p> : null}
          </div>
        ) : null}
      </div>

      <div className="team-canvas-toolbar__actions">
        <button type="button" onClick={onFitGraph} title="Fit the whole graph">
          <span aria-hidden="true" className="material-symbols-outlined">fit_screen</span>
          <span>Fit</span>
        </button>
        {mode === 'editor' ? (
          <>
            <i aria-hidden="true" />
            <button type="button" onClick={onOpenCatalog}>
              <span aria-hidden="true" className="material-symbols-outlined">add</span>
              <span>Agents</span>
            </button>
            <button type="button" onClick={onOpenTeam}>
              <span aria-hidden="true" className="material-symbols-outlined">edit_note</span>
              <span>Team</span>
            </button>
            <button type="button" onClick={onOpenReview}>
              <span aria-hidden="true" className="material-symbols-outlined">fact_check</span>
              <span>Review</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
