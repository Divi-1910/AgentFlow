import { memo } from 'react'
import { motion } from 'framer-motion'
import { Handle, Position } from '@xyflow/react'

function sceneInitial(scenePhase) {
  return scenePhase === 'entering'
    ? { opacity: 0, scale: 0.96, x: 46 }
    : false
}

function sceneAnimation(scenePhase) {
  if (scenePhase === 'exiting') {
    return {
      opacity: 0,
      scale: 0.96,
      transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
      x: -42,
    }
  }

  return {
    opacity: 1,
    scale: 1,
    transition: { duration: scenePhase === 'entering' ? 0.3 : 0.18, ease: [0.22, 1, 0.36, 1] },
    x: 0,
  }
}

function HiddenHandle({ id, position, type }) {
  return <Handle id={id} type={type} position={position} className="agent-forge-handle" />
}

export const AgentForgeNode = memo(function AgentForgeNode({ data }) {
  const { readiness } = data

  return (
    <motion.div
      key={data.identity}
      className={`agent-forge-core ${readiness.ready ? 'agent-forge-core--ready' : ''}`}
      initial={sceneInitial(data.scenePhase)}
      animate={sceneAnimation(data.scenePhase)}
      onAnimationComplete={() => {
        if (['entering', 'exiting'].includes(data.scenePhase)) {
          data.onSceneTransitionComplete?.(data.scenePhase)
        }
      }}
    >
      <HiddenHandle id="top" position={Position.Top} type="target" />
      <HiddenHandle id="right" position={Position.Right} type="target" />
      <HiddenHandle id="bottom" position={Position.Bottom} type="target" />
      <HiddenHandle id="left" position={Position.Left} type="target" />

      <span className="agent-forge-core__orbit agent-forge-core__orbit--outer" aria-hidden="true" />
      <span className="agent-forge-core__orbit agent-forge-core__orbit--inner" aria-hidden="true" />

      <button
        type="button"
        className="agent-forge-core__trigger nodrag nopan"
        onClick={data.onOpen}
        disabled={data.disabled}
        data-agent-core-trigger
        aria-label={`Configure ${data.name || 'untitled agent'}`}
      >
        <span
          className="agent-forge-core__progress"
          style={{ '--agent-readiness': `${readiness.percent * 3.6}deg` }}
          aria-hidden="true"
        >
          <span className="agent-forge-core__signal">
            <span className="material-symbols-outlined">neurology</span>
          </span>
        </span>

        <span key={data.identity} className="agent-forge-core__copy agent-forge-core__copy--switching">
          <span className="agent-forge-node__eyebrow">Agent core · {readiness.percent}% configured</span>
          <strong>{data.name || 'Untitled agent'}</strong>
          <span>{data.model || 'Select to begin configuration'}</span>
        </span>

      </button>
    </motion.div>
  )
})

export const AgentConfigNode = memo(function AgentConfigNode({ data }) {
  return (
    <motion.div
      key={data.identity}
      className="agent-forge-config-node__scene"
      initial={sceneInitial(data.scenePhase)}
      animate={sceneAnimation(data.scenePhase)}
    >
      <div className={`agent-forge-config-node agent-forge-config-node--${data.tone} ${data.exiting ? 'agent-forge-config-node--exiting' : ''}`}>
        <HiddenHandle id="top" position={Position.Top} type="source" />
        <HiddenHandle id="right" position={Position.Right} type="source" />
        <HiddenHandle id="bottom" position={Position.Bottom} type="source" />
        <HiddenHandle id="left" position={Position.Left} type="source" />
        <div className="agent-forge-config-node__topline">
          <span className="agent-forge-config-node__icon material-symbols-outlined" aria-hidden="true">
            {data.icon}
          </span>
          <span className="agent-forge-config-node__index">{data.index}</span>
        </div>
        <span className="agent-forge-node__eyebrow">{data.eyebrow}</span>
        <strong>{data.title}</strong>
        <span className="agent-forge-config-node__detail">{data.detail}</span>
      </div>
    </motion.div>
  )
})
