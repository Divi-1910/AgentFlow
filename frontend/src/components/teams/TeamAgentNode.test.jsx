import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TeamAgentNode from './TeamAgentNode'

vi.mock('framer-motion', async () => {
  const React = await import('react')
  function MotionArticle(props) {
    const articleProps = { ...props }
    articleProps['data-initial'] = JSON.stringify(articleProps.initial)
    articleProps['data-transition'] = JSON.stringify(articleProps.transition)
    articleProps.onClick = articleProps.onAnimationComplete
    delete articleProps.animate
    delete articleProps.initial
    delete articleProps.onAnimationComplete
    delete articleProps.transition
    return React.createElement('article', articleProps)
  }
  return {
    motion: {
      article: MotionArticle,
    },
    useReducedMotion: () => false,
  }
})

vi.mock('@xyflow/react', () => ({
  Handle: (props) => {
    const buttonProps = { ...props }
    delete buttonProps.isConnectableEnd
    delete buttonProps.isConnectableStart
    delete buttonProps.position
    delete buttonProps.type
    return <button type="button" {...buttonProps} />
  },
  Position: {
    Bottom: 'bottom',
    Left: 'left',
    Right: 'right',
    Top: 'top',
  },
  useStore: (selector) => selector({ transform: [0, 0, 1] }),
}))

const baseData = {
  agent: { name: 'Lead' },
  incomingCount: 2,
  outgoingCount: 3,
  portUsage: {
    bottom: { incoming: 0, outgoing: 2 },
    left: { incoming: 1, outgoing: 0 },
    right: { incoming: 1, outgoing: 1 },
  },
  scenePhase: 'idle',
}

describe('TeamAgentNode port awareness', () => {
  it('distinguishes unused, incoming, outgoing, and shared connection points', () => {
    render(<TeamAgentNode data={baseData} selected={false} />)

    expect(screen.getByLabelText('top connection point, unused').dataset.portState).toBe('unused')
    expect(screen.getByLabelText('left connection point, 1 incoming route').dataset.portState).toBe('incoming')
    expect(screen.getByLabelText('bottom connection point, 2 outgoing routes').dataset.portState).toBe('outgoing')
    expect(screen.getByLabelText('right connection point, 1 incoming and 1 outgoing routes').dataset.portState).toBe('both')
  })

  it('bounds large-team entrance stagger and completes from the designated final node', () => {
    const onSceneTransitionComplete = vi.fn()
    render(<TeamAgentNode data={{
      ...baseData,
      onSceneTransitionComplete,
      sceneAnchor: true,
      sceneIdentity: 'team-b',
      sceneIndex: 99,
      scenePhase: 'entering',
    }} selected={false} />)

    const node = screen.getByText('Lead').closest('article')
    expect(JSON.parse(node.dataset.initial)).toEqual({ opacity: 0, x: 36, scale: 0.96, filter: 'blur(7px)' })
    const transition = JSON.parse(node.dataset.transition)
    expect(transition.delay).toBeCloseTo(0.108)
    expect(transition.duration).toBe(0.32)
    fireEvent.click(node)
    expect(onSceneTransitionComplete).toHaveBeenCalledWith('entering')
  })
})
