import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ChatConversationIndex from './ChatConversationIndex'

const resources = [
  { id: 'agent-1', name: 'Research Agent', resource_kind: 'standalone_agent' },
  { id: 'team-1', name: 'Launch Team', resource_kind: 'agent_team' },
]

const threads = [
  { id: 'thread-1', resource_id: 'agent-1', title: 'Market research plan', updated_at: '2026-10-31T06:25:00Z' },
  { id: 'thread-2', resource_id: 'team-1', title: 'Launch readiness', updated_at: '2026-10-31T06:20:00Z' },
]

function renderIndex(overrides = {}) {
  const props = {
    onSelectResource: vi.fn(),
    onSelectThread: vi.fn(),
    onToggleCollapsed: vi.fn(),
    collapsed: false,
    resources,
    selectedResource: resources[0],
    selectedThread: threads[0],
    threads,
    ...overrides,
  }

  return { ...render(<ChatConversationIndex {...props} />), props }
}

describe('ChatConversationIndex', () => {
  it('presents conversation metadata without decorative resource glyphs', () => {
    const { container } = renderIndex()
    const history = screen.getByRole('navigation', { name: 'Conversation history' })

    expect(within(history).getByText('Market research plan')).toBeTruthy()
    expect(within(history).getByText('Research Agent')).toBeTruthy()
    expect(container.querySelector('.chat-resource-mark')).toBeNull()
    expect(history.querySelector('.material-symbols-outlined')).toBeNull()
  })

  it('filters conversations by title or intelligence name', async () => {
    const user = userEvent.setup()
    renderIndex()

    await user.type(screen.getByRole('textbox', { name: 'Search conversations' }), 'Launch Team')

    expect(screen.getByText('Launch readiness')).toBeTruthy()
    expect(screen.queryByText('Market research plan')).toBeNull()
  })

  it('switches into a searchable intelligence-selection mode', async () => {
    const user = userEvent.setup()
    renderIndex()

    await user.click(screen.getByRole('button', { name: 'Start a new conversation' }))

    expect(await screen.findByRole('heading', { name: 'New conversation' })).toBeTruthy()
    const search = await screen.findByRole('textbox', { name: 'Find an agent or team' })
    await user.type(search, 'team')
    expect(screen.getByText('Launch Team')).toBeTruthy()
    expect(screen.queryByText('Research Agent')).toBeNull()
  })

  it('selects intelligence and returns to conversation mode', async () => {
    const user = userEvent.setup()
    const { props } = renderIndex()

    await user.click(screen.getByRole('button', { name: 'Start a new conversation' }))
    const intelligence = await screen.findByRole('region', { name: 'Available intelligence' })
    await user.click(within(intelligence).getByRole('button', { name: /Launch Team/ }))

    expect(props.onSelectResource).toHaveBeenCalledWith(resources[1])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy())
  })

  it('opens the selected conversation through the existing callback', async () => {
    const user = userEvent.setup()
    const { props } = renderIndex()

    await user.click(screen.getByRole('button', { name: /Launch readiness/ }))

    expect(props.onSelectThread).toHaveBeenCalledWith(threads[1])
  })

  it('keeps new conversation available when the index is collapsed', async () => {
    const user = userEvent.setup()
    const { props } = renderIndex({ collapsed: true })

    await user.click(screen.getByRole('button', { name: 'Start a new conversation' }))

    expect(props.onToggleCollapsed).toHaveBeenCalledOnce()
  })
})
