import { layoutTeamGraph, normalizeTeamPort, suggestedDelegationName } from '../teams/teamGraph'

export const TEAM_TEMPLATES = Object.freeze([
  {
    description: 'A lead decomposes a question, a researcher gathers evidence, and a writer turns the result into a clear deliverable.',
    edges: [
      { source: 'lead', sourcePort: 'right', target: 'researcher', targetPort: 'left' },
      { source: 'lead', sourcePort: 'bottom', target: 'writer', targetPort: 'top' },
    ],
    icon: 'hub',
    id: 'research_pod',
    name: 'Research Pod',
    slots: [
      { description: 'Receives the user request and decides what to delegate.', id: 'lead', label: 'Lead' },
      { description: 'Finds and evaluates the evidence needed by the lead.', id: 'researcher', label: 'Researcher' },
      { description: 'Shapes validated findings into the final response.', id: 'writer', label: 'Writer' },
    ],
  },
  {
    description: 'A delivery lead delegates implementation to a builder, then the builder requests an independent review.',
    edges: [
      { source: 'lead', sourcePort: 'right', target: 'builder', targetPort: 'left' },
      { source: 'builder', sourcePort: 'right', target: 'reviewer', targetPort: 'left' },
    ],
    icon: 'account_tree',
    id: 'delivery_cell',
    name: 'Delivery Cell',
    slots: [
      { description: 'Owns the request, scope, and final delivery decision.', id: 'lead', label: 'Delivery lead' },
      { description: 'Performs the implementation or operational work.', id: 'builder', label: 'Builder' },
      { description: 'Checks the result independently before completion.', id: 'reviewer', label: 'Reviewer' },
    ],
  },
])

export function teamTemplateById(templateId) {
  return TEAM_TEMPLATES.find((template) => template.id === templateId) || null
}

export function createTeamTemplateDraft(templateId, assignments, agents = []) {
  const template = teamTemplateById(templateId)
  if (!template) return null
  const assignmentMap = assignments || {}
  if (template.slots.some((slot) => !assignmentMap[slot.id])) return null
  const selectedIds = template.slots.map((slot) => assignmentMap[slot.id])
  if (new Set(selectedIds).size !== selectedIds.length) return null

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const draft = {
    description: template.description,
    entry_agent_id: assignmentMap[template.slots[0].id],
    name: template.name,
    nodes: selectedIds.map((agentId, index) => ({
      agent_id: agentId,
      position: { x: 120 + (index * 250), y: 300 },
    })),
    edges: template.edges.map((edge) => {
      const targetId = assignmentMap[edge.target]
      return {
        description: `Delegate work to ${agentsById.get(targetId)?.name || 'this specialist'}.`,
        instructions: '',
        source_agent_id: assignmentMap[edge.source],
        source_port: normalizeTeamPort(edge.sourcePort, 'right'),
        target_agent_id: targetId,
        target_port: normalizeTeamPort(edge.targetPort, 'left'),
        tool_name: suggestedDelegationName(agentsById.get(targetId)),
      }
    }),
  }
  return layoutTeamGraph(draft)
}
