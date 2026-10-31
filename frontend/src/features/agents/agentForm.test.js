import { describe, expect, it } from 'vitest'
import {
  agentToForm,
  buildAgentPatch,
  buildCreateAgentPayload,
  createEmptyAgentForm,
  validateAgentForm,
} from './agentForm'

const savedAgent = {
  context_keep_ratio: 0.5,
  context_window: 8,
  description: 'Original description',
  max_runs: 4,
  max_steps: 12,
  max_tokens: 2048,
  mcp_servers: [{ server_id: 'fetch' }],
  model: 'gpt-5.6-luna',
  name: 'Research Analyst',
  provider: 'openai',
  summarization_model: '',
  system_prompt: 'Research carefully.',
  temperature: 0.4,
  tools: ['web_search'],
}

describe('agent form contract', () => {
  it('omits untouched advanced defaults from creation payloads', () => {
    const form = {
      ...createEmptyAgentForm(),
      mcp_server_ids: ['fetch'],
      model: 'gpt-5.6-luna',
      name: ' Research Analyst ',
      provider: 'openai',
      system_prompt: 'Research carefully.',
      tools: ['web_search'],
    }

    expect(buildCreateAgentPayload(form)).toEqual({
      description: '',
      mcp_servers: [{ server_id: 'fetch' }],
      model: 'gpt-5.6-luna',
      name: 'Research Analyst',
      provider: 'openai',
      system_prompt: 'Research carefully.',
      tools: ['web_search'],
    })
  })

  it('produces a minimal patch containing only dirty fields', () => {
    const form = agentToForm(savedAgent)
    form.description = 'Updated description'

    expect(buildAgentPatch(form, savedAgent)).toEqual({
      description: 'Updated description',
    })
  })

  it('preserves the MCP server_id object contract when selections change', () => {
    const form = agentToForm(savedAgent)
    form.mcp_server_ids = ['fetch', 'open-meteo']

    expect(buildAgentPatch(form, savedAgent)).toEqual({
      mcp_servers: [
        { server_id: 'fetch' },
        { server_id: 'open-meteo' },
      ],
    })
  })

  it('validates required fields and backend tuning limits', () => {
    const form = createEmptyAgentForm()
    form.temperature = '1.2'
    form.context_window = '0'

    expect(validateAgentForm(form)).toMatchObject({
      context_window: 'Enter a whole number greater than 0.',
      model: 'This field is required.',
      name: 'This field is required.',
      provider: 'This field is required.',
      system_prompt: 'This field is required.',
      temperature: 'Enter a number greater than 0 and at most 1.',
    })
  })
})
