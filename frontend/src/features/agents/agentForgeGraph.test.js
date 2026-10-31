import { describe, expect, it } from 'vitest'
import { createEmptyAgentForm } from './agentForm'
import {
  agentToolGroups,
  getAgentReadiness,
  getSelectedAgentCapabilities,
  getToolGroupSelection,
  tabForAgentField,
  toggleToolGroup,
} from './agentForgeGraph'

describe('agent forge graph', () => {
  it('derives readiness from the four required configuration fields', () => {
    const form = {
      ...createEmptyAgentForm(),
      model: 'gpt-5.6-luna',
      name: 'Research Analyst',
      provider: 'openai',
      system_prompt: 'Research carefully.',
    }

    expect(getAgentReadiness(form)).toEqual({
      completed: 4,
      percent: 100,
      ready: true,
      total: 4,
    })
  })

  it('exposes only selected tools and MCP servers as persistent canvas capabilities', () => {
    const form = {
      ...createEmptyAgentForm(),
      mcp_server_ids: ['fetch'],
      model: 'gpt-5.6-luna',
      system_prompt: 'Research carefully.',
      tools: ['web_search'],
    }
    const capabilities = getSelectedAgentCapabilities(
      form,
      [{ description: 'Searches the web.', name: 'web_search' }],
      [{ description: 'Fetches a URL.', name: 'Fetch', server_id: 'fetch' }],
    )

    expect(capabilities.map((capability) => capability.id)).toEqual(['tool:web_search', 'mcp:fetch'])
    expect(capabilities.some((capability) => capability.id.includes('model'))).toBe(false)
    expect(capabilities.some((capability) => capability.id.includes('system_prompt'))).toBe(false)
  })

  it('collapses memory operations into one canvas capability without hiding a partial legacy selection', () => {
    const memory = agentToolGroups.find((group) => group.id === 'memory')
    const form = {
      ...createEmptyAgentForm(),
      tools: [memory.tools[0], memory.tools[1], 'web_search'],
    }
    const toolChoices = [...memory.tools, 'web_search'].map((name) => ({ name }))

    const capabilities = getSelectedAgentCapabilities(form, toolChoices, [])

    expect(capabilities.map((capability) => capability.id)).toEqual([
      'tool-group:memory',
      'tool:web_search',
    ])
    expect(capabilities[0]).toMatchObject({
      description: '2 of 8 operations enabled',
      kind: 'Core capability · Partial',
      label: 'Memory',
    })
  })

  it('completes a partial tool group and removes a fully selected group as one unit', () => {
    const memory = agentToolGroups.find((group) => group.id === 'memory')
    const partialTools = ['calculator', memory.tools[0]]

    expect(getToolGroupSelection(partialTools, memory.tools)).toEqual({
      selectedCount: 1,
      state: 'partial',
      total: 8,
    })

    const completedTools = toggleToolGroup(partialTools, memory.tools)
    expect(completedTools).toEqual(['calculator', ...memory.tools])
    expect(toggleToolGroup(completedTools, memory.tools)).toEqual(['calculator'])
  })

  it('maps validation fields to the inspector tab that owns them', () => {
    expect(tabForAgentField('system_prompt')).toBe('instructions')
    expect(tabForAgentField('model')).toBe('model')
    expect(tabForAgentField('mcp_servers')).toBe('capabilities')
    expect(tabForAgentField('max_tokens')).toBe('runtime')
    expect(tabForAgentField('name')).toBe('overview')
  })
})
