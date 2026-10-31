import { memo } from 'react'
import { useReducedMotion } from 'framer-motion'
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'

function pulseDelay(id) {
  const hash = [...String(id)].reduce((total, character) => total + character.charCodeAt(0), 0)
  return `-${(hash % 14) / 10}s`
}

function TeamDelegationEdge({ data, id, markerEnd, selected, sourceX, sourceY, sourcePosition, style, targetX, targetY, targetPosition }) {
  const reduceMotion = useReducedMotion()
  const [path, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  })
  const pulseDuration = selected ? '1.05s' : data?.focused ? '1.3s' : '1.75s'
  const pulseOpacity = data?.dimmed ? 0.08 : selected ? 1 : data?.focused ? 0.9 : 0.68
  const sceneTransitioning = data?.scenePhase === 'entering' || data?.scenePhase === 'exiting'
  const delay = pulseDelay(id)

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={path}
        style={{
          ...style,
          opacity: sceneTransitioning ? 0 : data?.dimmed ? 0.1 : 1,
          stroke: selected ? 'rgba(255,255,255,0.95)' : data?.focused ? 'rgba(255,255,255,0.58)' : 'rgba(255,255,255,0.25)',
          strokeWidth: selected ? 1.8 : data?.focused ? 1.35 : 1,
          transition: 'opacity 180ms ease, stroke 180ms ease',
        }}
      />
      {!reduceMotion ? (
        <g
          aria-hidden="true"
          style={{ opacity: sceneTransitioning ? 0 : 1, transition: 'opacity 160ms ease' }}
        >
          <g className={`team-delegation-pulse ${data?.focused ? 'team-delegation-pulse--focused' : ''} ${selected ? 'team-delegation-pulse--selected' : ''}`}>
            <circle className="team-delegation-pulse__glow" r={selected ? 7.5 : 6.5} />
            <circle className="team-delegation-pulse__core" r={selected ? 2.6 : 2.2} />
            <animateMotion begin={delay} dur={pulseDuration} path={path} repeatCount="indefinite" />
            <animate
              attributeName="opacity"
              begin={delay}
              dur={pulseDuration}
              keyTimes="0;0.12;0.82;1"
              repeatCount="indefinite"
              values={`0;${pulseOpacity};${pulseOpacity};0`}
            />
          </g>
        </g>
      ) : null}
      {data?.labelVisible && !sceneTransitioning ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={`team-delegation-label nodrag nopan ${selected ? 'team-delegation-label--selected' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(event) => {
              event.stopPropagation()
              data?.onSelect?.(id)
            }}
          >
            <span>{data?.sourceName || 'Agent'} <i aria-hidden="true">→</i> {data?.targetName || 'Agent'}</span>
            {selected ? <small>{data?.condition || 'Describe when this route should be used.'}</small> : null}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export default memo(TeamDelegationEdge)
