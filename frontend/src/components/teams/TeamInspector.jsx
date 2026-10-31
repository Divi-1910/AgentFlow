import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { delegationId } from '../../features/teams/teamGraph'
import TeamExecutionSummary from './TeamExecutionSummary'
import useTeamCanvasPanelInset from './useTeamCanvasPanelInset'

function ErrorText({ children }) {
  return children ? <p className="team-field-error" role="alert">{children}</p> : null
}

export default function TeamInspector({
  agents,
  draft,
  onCanvasInsetChange,
  onClose,
  onConnectAgents,
  onOpenAgent,
  onRemoveEdge,
  onRemoveNode,
  onSelect,
  onSetEntry,
  onSetField,
  onUpdateEdge,
  returning = false,
  selection,
  validation = { edgeErrors: {}, errors: {}, valid: false },
  view = 'selection',
}) {
  const [routePickerMode, setRoutePickerMode] = useState(null)
  const panelRef = useTeamCanvasPanelInset('right', onCanvasInsetChange)
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const selectedAgent = selection.type === 'node' ? agentsById.get(selection.id) : null
  const selectedEdge = selection.type === 'edge'
    ? draft.edges.find((edge) => delegationId(edge.source_agent_id, edge.target_agent_id) === selection.id)
    : null
  const sourceAgent = selectedEdge ? agentsById.get(selectedEdge.source_agent_id) : null
  const targetAgent = selectedEdge ? agentsById.get(selectedEdge.target_agent_id) : null
  const outgoingRoutes = selectedAgent ? draft.edges.filter((edge) => edge.source_agent_id === selectedAgent.id) : []
  const incomingRoutes = selectedAgent ? draft.edges.filter((edge) => edge.target_agent_id === selectedAgent.id) : []
  const targetChoices = selectedAgent
    ? draft.nodes
      .filter((node) => node.agent_id !== selectedAgent.id)
      .filter((node) => !outgoingRoutes.some((edge) => edge.target_agent_id === node.agent_id))
      .map((node) => agentsById.get(node.agent_id))
      .filter(Boolean)
    : []
  const sourceChoices = selectedAgent && draft.entry_agent_id !== selectedAgent.id
    ? draft.nodes
      .filter((node) => node.agent_id !== selectedAgent.id)
      .filter((node) => !incomingRoutes.some((edge) => edge.source_agent_id === node.agent_id))
      .map((node) => agentsById.get(node.agent_id))
      .filter(Boolean)
    : []
  const errors = validation.errors || {}
  const edgeErrors = validation.edgeErrors || {}
  const titles = {
    review: ['Execution review', 'Read the graph as runtime behavior before saving.'],
    selection: [selectedEdge ? 'Delegation route' : 'Agent details', 'Inspect and change only the selected graph element.'],
    team: ['Team settings', 'Identity and entry behavior for this orchestration.'],
  }

  return (
    <motion.aside
      ref={panelRef}
      className="team-inspector"
      aria-label={titles[view][0]}
      initial={{ opacity: 0, x: 'calc(100% + 2rem)' }}
      animate={returning ? { opacity: 0, x: 'calc(100% + 2rem)' } : { opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 'calc(100% + 2rem)' }}
      transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="team-panel-heading team-panel-heading--context">
        <div><span>{titles[view][0]}</span><p>{titles[view][1]}</p></div>
        <button type="button" className="team-panel-close" onClick={onClose} aria-label={`Close ${titles[view][0]}`}>
          <span aria-hidden="true" className="material-symbols-outlined">close</span>
        </button>
      </div>

      <div className="team-inspector__body">
        {view === 'team' ? (
          <>
            <div className="team-section-intro">
              <span>Team identity</span>
              <strong>What should this Team be known for?</strong>
              <p>The Team identifies an orchestration. Each Agent keeps its own instructions, model, tools, and MCP capabilities.</p>
            </div>
            <label className="agent-field-label" htmlFor="team-name">Team name</label>
            <input id="team-name" className="agent-input" value={draft.name} onChange={(event) => onSetField('name', event.target.value)} placeholder="Research collective" />
            <ErrorText>{errors.name}</ErrorText>
            <label className="agent-field-label" htmlFor="team-description">Purpose <span>Recommended</span></label>
            <textarea id="team-description" className="agent-input team-textarea" value={draft.description} onChange={(event) => onSetField('description', event.target.value)} placeholder="Researches a topic, verifies evidence, and returns a concise report." />
            <div className="team-graph-status">
              <span>Current topology</span>
              <strong>{draft.nodes.length} Agents · {draft.edges.length} routes</strong>
              <p>{draft.entry_agent_id ? `${agentsById.get(draft.entry_agent_id)?.name || 'The selected Agent'} receives every user request.` : 'Add an Agent to establish the entry point.'}</p>
            </div>
            <ErrorText>{errors.entry_agent_id || errors.graph}</ErrorText>
          </>
        ) : null}

        {view === 'selection' && selectedEdge ? (
          <>
            <div className="team-section-intro">
              <span>Callable delegation</span>
              <strong>{sourceAgent?.name || 'Agent'} <i aria-hidden="true">→</i> {targetAgent?.name || 'Agent'}</strong>
              <p>This is an optional tool for {sourceAgent?.name || 'the source Agent'}, not an automatic next step.</p>
            </div>
            <label className="agent-field-label" htmlFor="delegation-description">When should this route be used?</label>
            <textarea id="delegation-description" className="agent-input team-textarea" value={selectedEdge.description} onChange={(event) => onUpdateEdge(selection.id, 'description', event.target.value)} placeholder={`Use ${targetAgent?.name || 'this Agent'} when…`} />
            <label className="agent-field-label" htmlFor="delegation-instructions">Context for the receiving Agent <span>Optional</span></label>
            <textarea id="delegation-instructions" className="agent-input team-textarea" value={selectedEdge.instructions || ''} onChange={(event) => onUpdateEdge(selection.id, 'instructions', event.target.value)} placeholder="Include citations, preserve the requested format, and explain uncertainty." />
            <ErrorText>{edgeErrors[selection.id]}</ErrorText>
            <details className="team-advanced-field">
              <summary>Invocation name</summary>
              <p>This is the callable tool name exposed to the source model.</p>
              <input className="agent-input" value={selectedEdge.tool_name} onChange={(event) => onUpdateEdge(selection.id, 'tool_name', event.target.value)} />
            </details>
            <button type="button" className="agent-danger-button team-inspector__action" onClick={() => onRemoveEdge(selection.id)}>
              <span aria-hidden="true" className="material-symbols-outlined">link_off</span>Remove route
            </button>
          </>
        ) : null}

        {view === 'selection' && selectedAgent ? (
          <>
            <div className="team-agent-detail">
              <span aria-hidden="true" className="material-symbols-outlined">smart_toy</span>
              <div><span>{draft.entry_agent_id === selectedAgent.id ? 'Entry Agent' : 'Delegate Agent'}</span><strong>{selectedAgent.name}</strong><p>{selectedAgent.provider} · {selectedAgent.model}</p></div>
            </div>
            <p className="team-agent-runtime-note">
              {draft.entry_agent_id === selectedAgent.id
                ? 'This Agent receives the user request and decides whether delegation is needed.'
                : 'This Agent runs only when another Agent delegates to it. Its answer returns to that caller.'}
            </p>
            <dl className="team-agent-metrics">
              <div><dt>Incoming routes</dt><dd>{incomingRoutes.length}</dd></div>
              <div><dt>Outgoing routes</dt><dd>{outgoingRoutes.length}</dd></div>
            </dl>
            <section className="team-route-builder">
              <div><span>Connected routes</span><small>Select a route to edit its runtime meaning.</small></div>
              {[...incomingRoutes, ...outgoingRoutes].map((edge) => {
                const id = delegationId(edge.source_agent_id, edge.target_agent_id)
                const source = agentsById.get(edge.source_agent_id)
                const target = agentsById.get(edge.target_agent_id)
                return (
                  <button key={id} type="button" onClick={() => onSelect({ id, type: 'edge' })}>
                    <span><strong>{source?.name || 'Agent'} → {target?.name || 'Agent'}</strong><small>{edge.description}</small></span>
                    <i aria-hidden="true" className="material-symbols-outlined">arrow_forward</i>
                  </button>
                )
              })}
              {routePickerMode ? (
                <div className="team-route-targets">
                  <p>{routePickerMode === 'incoming' ? `Choose who may ask ${selectedAgent.name} for help.` : `Choose who ${selectedAgent.name} may ask for help.`}</p>
                  {(routePickerMode === 'incoming' ? sourceChoices : targetChoices).map((agent) => (
                    <button key={agent.id} type="button" onClick={() => {
                      const created = onConnectAgents(
                        routePickerMode === 'incoming' ? agent.id : selectedAgent.id,
                        routePickerMode === 'incoming' ? selectedAgent.id : agent.id,
                      )
                      if (created !== false) setRoutePickerMode(null)
                    }}>
                      <span aria-hidden="true" className="material-symbols-outlined">add</span><span><strong>{agent.name}</strong><small>{agent.description || agent.model}</small></span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="team-route-builder__actions">
                {sourceChoices.length > 0 ? <button type="button" onClick={() => setRoutePickerMode((mode) => mode === 'incoming' ? null : 'incoming')}>Receive from…</button> : null}
                {targetChoices.length > 0 ? <button type="button" onClick={() => setRoutePickerMode((mode) => mode === 'outgoing' ? null : 'outgoing')}>Delegate to…</button> : null}
              </div>
            </section>
            {draft.entry_agent_id !== selectedAgent.id ? <button type="button" className="agent-secondary-button team-inspector__action" onClick={() => onSetEntry(selectedAgent.id)}><span aria-hidden="true" className="material-symbols-outlined">flag</span>Make entry Agent</button> : null}
            <button type="button" className="agent-secondary-button team-inspector__action" onClick={() => onOpenAgent(selectedAgent.id)}><span aria-hidden="true" className="material-symbols-outlined">open_in_new</span>Open Agent Forge</button>
            <button type="button" className="agent-danger-button team-inspector__action" onClick={() => onRemoveNode(selectedAgent.id)}><span aria-hidden="true" className="material-symbols-outlined">remove_circle</span>Remove from Team</button>
          </>
        ) : null}

        {view === 'review' ? <TeamExecutionSummary agents={agents} draft={draft} onSelectRoute={(id) => onSelect({ id, type: 'edge' })} validation={validation} /> : null}
      </div>
    </motion.aside>
  )
}
