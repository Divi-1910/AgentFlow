import { memo } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Handle, Position, useStore } from '@xyflow/react'

const ports = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
]

function getPortState(portUsage = {}) {
  const incoming = portUsage.incoming || 0
  const outgoing = portUsage.outgoing || 0
  if (incoming > 0 && outgoing > 0) return 'both'
  if (incoming > 0) return 'incoming'
  if (outgoing > 0) return 'outgoing'
  return 'unused'
}

function getPortLabel(port, portUsage = {}) {
  const incoming = portUsage.incoming || 0
  const outgoing = portUsage.outgoing || 0
  if (incoming > 0 && outgoing > 0) return `${port} connection point, ${incoming} incoming and ${outgoing} outgoing routes`
  if (incoming > 0) return `${port} connection point, ${incoming} incoming ${incoming === 1 ? 'route' : 'routes'}`
  if (outgoing > 0) return `${port} connection point, ${outgoing} outgoing ${outgoing === 1 ? 'route' : 'routes'}`
  return `${port} connection point, unused`
}

function TeamAgentNode({ data, selected }) {
  const reduceMotion = useReducedMotion()
  const density = useStore((state) => {
    const zoom = state.transform[2]
    return zoom < 0.52 ? 'far' : zoom < 0.82 ? 'medium' : 'close'
  })
  const exiting = data.scenePhase === 'exiting'
  const entering = data.scenePhase === 'entering'
  const enteringDelay = entering ? Math.min(data.sceneIndex, 6) * 0.018 : 0

  return (
    <motion.article
      key={data.sceneIdentity}
      className={`team-agent-node team-agent-node--${density} ${selected ? 'team-agent-node--selected' : ''} ${data.entry ? 'team-agent-node--entry' : ''} ${data.focused ? 'team-agent-node--focused' : ''} ${data.dimmed ? 'team-agent-node--dimmed' : ''}`}
      initial={entering && !reduceMotion ? { opacity: 0, x: 36, scale: 0.96, filter: 'blur(7px)' } : false}
      animate={exiting && !reduceMotion
        ? { opacity: 0, x: -36, scale: 0.96, filter: 'blur(7px)' }
        : { opacity: 1, x: 0, scale: 1, filter: 'blur(0px)' }}
      transition={{
        delay: enteringDelay,
        duration: reduceMotion ? 0 : entering ? 0.32 : 0.22,
        ease: entering ? [0.22, 1, 0.36, 1] : [0.4, 0, 1, 1],
      }}
      onAnimationComplete={() => {
        if (data.sceneAnchor && data.scenePhase !== 'idle') data.onSceneTransitionComplete?.(data.scenePhase)
      }}
    >
      {ports.map((port) => {
        const usage = data.portUsage?.[port.id]
        const state = getPortState(usage)
        return (
          <Handle
            key={port.id}
            aria-label={getPortLabel(port.id, usage)}
            className={`team-agent-node__handle team-agent-node__handle--${port.id} team-agent-node__handle--${state}`}
            data-port-state={state}
            id={port.id}
            isConnectableEnd
            isConnectableStart
            position={port.position}
            title={`Connect from or to the ${port.id} side`}
            type="source"
          />
        )
      })}
      <span className="team-agent-node__role">{data.entry ? 'Entry' : 'Agent'}</span>
      <strong>{data.agent?.name || 'Unavailable agent'}</strong>
      <div className="team-agent-node__routes" aria-label={`${data.incomingCount} incoming and ${data.outgoingCount} outgoing routes`}>
        <span><b>{data.incomingCount}</b> in</span>
        <i aria-hidden="true" />
        <span><b>{data.outgoingCount}</b> out</span>
      </div>
    </motion.article>
  )
}

export default memo(TeamAgentNode)
