import { describe, expect, it } from 'vitest'
import { createAgentTemplateForm } from './agentTemplates'
import { createTeamTemplateDraft } from './teamTemplates'

describe('built-in templates', () => {
  it('prefills an agent without choosing a provider or model', () => {
    const form = createAgentTemplateForm('research_analyst', [
      { available: true, name: 'memory_read' },
      { available: false, name: 'fetch' },
    ])
    expect(form.name).toBe('Research Analyst')
    expect(form.provider).toBe('')
    expect(form.model).toBe('')
    expect(form.tools).toEqual(['memory_read'])
  })

  it('creates a directed team graph from distinct slot assignments', () => {
    const agents = [
      { id: 'lead', name: 'Lead' },
      { id: 'research', name: 'Research' },
      { id: 'writer', name: 'Writer' },
    ]
    const draft = createTeamTemplateDraft('research_pod', {
      lead: 'lead',
      researcher: 'research',
      writer: 'writer',
    }, agents)
    expect(draft.entry_agent_id).toBe('lead')
    expect(draft.nodes).toHaveLength(3)
    expect(draft.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_agent_id: 'lead', target_agent_id: 'research' }),
      expect.objectContaining({ source_agent_id: 'lead', target_agent_id: 'writer' }),
    ]))
  })

  it('rejects a team mapping that reuses the same agent for two roles', () => {
    expect(createTeamTemplateDraft('delivery_cell', {
      builder: 'same',
      lead: 'same',
      reviewer: 'other',
    })).toBeNull()
  })
})
