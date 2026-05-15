import { motion } from 'framer-motion'

/*
  AgentVisual — SVG ReAct orbit diagram
  ─────────────────────────────────────
  Three nodes (REASON / ACT / OBSERVE) placed on a circle at 120° intervals.
  Curved arcs connect them with a flowing dash animation.
  Two concentric rings rotate at different speeds in opposite directions.
  Everything is white at very low opacity so it reads as texture, not noise.

  SVG coordinate space: 280 × 280, centre = (140, 140)
*/

const C       = 140   // centre
const RING_R  = 112   // outer decorative ring radius
const NODE_R  = 82    // radius where node dots sit
const DOT_R   = 3.5   // node dot radius
const FONT    = "'Clash Display', 'Trebuchet MS', sans-serif"

const toRad = d => (d * Math.PI) / 180

const NODES = [
  { label: 'REASON',  deg: -90  },   // top
  { label: 'ACT',     deg:  30  },   // bottom-right
  { label: 'OBSERVE', deg: 150  },   // bottom-left
]

function nodeXY(deg) {
  return {
    x: C + NODE_R * Math.cos(toRad(deg)),
    y: C + NODE_R * Math.sin(toRad(deg)),
  }
}

// Quadratic bezier arc curving slightly toward centre
function arcPath(fromDeg, toDeg) {
  const f = nodeXY(fromDeg)
  const t = nodeXY(toDeg)
  const mx = (f.x + t.x) / 2
  const my = (f.y + t.y) / 2
  // Pull control point 30% toward centre
  const qx = mx + (C - mx) * 0.30
  const qy = my + (C - my) * 0.30
  return `M ${f.x.toFixed(1)} ${f.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${t.x.toFixed(1)} ${t.y.toFixed(1)}`
}

// Label anchor offset so text doesn't overlap the dot
function labelOffset(deg) {
  const rad = toRad(deg)
  const nx = Math.cos(rad)
  const ny = Math.sin(rad)
  const dist = 18
  return { x: nx * dist, y: ny * dist }
}

const ARCS = [
  [NODES[0].deg, NODES[1].deg],
  [NODES[1].deg, NODES[2].deg],
  [NODES[2].deg, NODES[0].deg],
]

export default function AgentVisual() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.88 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.4, delay: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-none select-none flex items-center justify-center"
      style={{ width: 230, height: 230, flexShrink: 0 }}
    >
      <svg
        viewBox="0 0 280 280"
        width="100%"
        height="100%"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* ── Outer orbit ring — slow CW rotation ── */}
        <g style={{ transformOrigin: `${C}px ${C}px`, animation: 'agent-orbit 36s linear infinite' }}>
          <circle
            cx={C} cy={C} r={RING_R}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="0.6"
            strokeDasharray="2 12"
          />
          {/* Tick marks at 30° intervals */}
          {Array.from({ length: 12 }).map((_, i) => {
            const a = toRad(i * 30)
            const x1 = C + (RING_R - 5) * Math.cos(a)
            const y1 = C + (RING_R - 5) * Math.sin(a)
            const x2 = C + RING_R * Math.cos(a)
            const y2 = C + RING_R * Math.sin(a)
            return (
              <line
                key={i}
                x1={x1.toFixed(1)} y1={y1.toFixed(1)}
                x2={x2.toFixed(1)} y2={y2.toFixed(1)}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="0.6"
              />
            )
          })}
        </g>

        {/* ── Inner ring — slow CCW rotation ── */}
        <g style={{ transformOrigin: `${C}px ${C}px`, animation: 'agent-orbit-rev 22s linear infinite' }}>
          <circle
            cx={C} cy={C} r={NODE_R * 0.38}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="0.5"
            strokeDasharray="1 6"
          />
        </g>

        {/* ── Connecting arcs with flow animation ── */}
        {ARCS.map(([from, to], i) => (
          <path
            key={i}
            d={arcPath(from, to)}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeDasharray="4 7"
            style={{
              animation: 'agent-flow 2s linear infinite',
              animationDelay: `${i * -0.67}s`,
            }}
          />
        ))}

        {/* ── Static arc outline (base layer under flow) ── */}
        {ARCS.map(([from, to], i) => (
          <path
            key={`base-${i}`}
            d={arcPath(from, to)}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth="0.6"
            strokeLinecap="round"
          />
        ))}

        {/* ── Nodes ── */}
        {NODES.map(({ label, deg }, i) => {
          const { x, y } = nodeXY(deg)
          const off = labelOffset(deg)

          // Text anchor based on horizontal position
          const anchor = x < C - 10 ? 'end' : x > C + 10 ? 'start' : 'middle'

          return (
            <g key={label}>
              {/* Ping ring */}
              <circle
                cx={x} cy={y} r={DOT_R + 3}
                fill="rgba(255,255,255,0.04)"
                style={{
                  animation: 'agent-pulse 3.5s ease-in-out infinite',
                  animationDelay: `${i * 1.15}s`,
                  transformOrigin: `${x}px ${y}px`,
                }}
              />
              {/* Dot */}
              <circle
                cx={x} cy={y} r={DOT_R}
                fill="rgba(255,255,255,0.55)"
                style={{
                  animation: 'agent-pulse 3.5s ease-in-out infinite',
                  animationDelay: `${i * 1.15}s`,
                }}
              />
              {/* Label */}
              <text
                x={(x + off.x).toFixed(1)}
                y={(y + off.y).toFixed(1)}
                textAnchor={anchor}
                dominantBaseline="middle"
                fontSize="6.5"
                fontFamily={FONT}
                fontWeight="700"
                letterSpacing="0.12em"
                fill="rgba(255,255,255,0.28)"
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* ── Centre node ── */}
        <circle cx={C} cy={C} r="10" fill="rgba(255,255,255,0.03)" />
        <circle cx={C} cy={C} r="2.5" fill="rgba(255,255,255,0.45)"
          style={{ animation: 'agent-pulse 2.2s ease-in-out infinite' }} />

        {/* Centre label */}
        <text
          x={C} y={C + 16}
          textAnchor="middle"
          fontSize="5.5"
          fontFamily={FONT}
          fontWeight="700"
          letterSpacing="0.18em"
          fill="rgba(255,255,255,0.14)"
        >
          REACT
        </text>
      </svg>
    </motion.div>
  )
}
