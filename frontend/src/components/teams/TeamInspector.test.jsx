import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import TeamInspector from './TeamInspector'

const agents = [
  { description: 'Coordinates the work.', id: 'lead', model: 'gpt-5.6-luna', name: 'Lead', provider: 'openai' },
  { description: 'Writes the final report.', id: 'writer', model: 'gpt-5.6-luna', name: 'Writer', provider: 'openai' },
]

const draft = {
  description: 'Researches and writes reports.',
  edges: [],
  entry_agent_id: 'lead',
  name: 'Research Team',
  nodes: [
    { agent_id: 'lead', position: { x: 0, y: 0 } },
    { agent_id: 'writer', position: { x: 320, y: 0 } },
  ],
}

function renderInspector(overrides = {}) {
  const props = {
    agents,
    draft,
    onClose: vi.fn(),
    onConnectAgents: vi.fn(),
    onOpenAgent: vi.fn(),
    onRemoveEdge: vi.fn(),
    onRemoveNode: vi.fn(),
    onSelect: vi.fn(),
    onSetEntry: vi.fn(),
    onSetField: vi.fn(),
    onUpdateEdge: vi.fn(),
    selection: { id: 'writer', type: 'node' },
    validation: {
      edgeErrors: {},
      errors: { graph: 'Every agent must be reachable from the entry agent.' },
      valid: false,
    },
    ...overrides,
  }
  render(<TeamInspector {...props} />)
  return props
}

describe('TeamInspector', () => {
  it('shows only contextual Agent details for a selected node', () => {
    renderInspector()

    expect(screen.getByText('This Agent runs only when another Agent delegates to it. Its answer returns to that caller.')).toBeTruthy()
    expect(screen.queryByDisplayValue('Research Team')).toBeNull()
  })

  it('shows Team identity only when the Team settings surface is requested', () => {
    renderInspector({ view: 'team' })

    expect(screen.getByDisplayValue('Research Team')).toBeTruthy()
  })

  it('creates an understandable incoming route for a newly added Agent', async () => {
    const props = renderInspector()

    await userEvent.click(screen.getByRole('button', { name: 'Receive from…' }))
    await userEvent.click(screen.getByRole('button', { name: /Lead/ }))

    expect(props.onConnectAgents).toHaveBeenCalledWith('lead', 'writer')
  })

  it('keeps the route choice visible when the graph rejects the connection', async () => {
    renderInspector({ onConnectAgents: vi.fn(() => false) })

    await userEvent.click(screen.getByRole('button', { name: 'Receive from…' }))
    await userEvent.click(screen.getByRole('button', { name: /Lead/ }))

    expect(screen.getByText('Choose who may ask Writer for help.')).toBeTruthy()
  })
})
