import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { motion } from 'framer-motion'
import * as THREE from 'three'
import { BOTS } from './armorBot/botRegistry'
import { BotShow } from './armorBot/botShow'

// ─────────────────────────────────────────────────────────────────
//  The hero shows a cycle of code-built robots (img2threejs, see
//  hero-bot-workspace/). BotShow loads them on demand, holds one,
//  transforms into the next and runs the subtle idle animation.
//  Phones, where this scene is hidden, never download any of it.
// ─────────────────────────────────────────────────────────────────

const DESKTOP_QUERY = '(min-width: 1024px)'

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    const onChange = (e) => setDesktop(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return desktop
}

// Procedural studio (no network fetch): a dark room with a few softboxes. Glossy clear-coat and gold only look
// like armour when they have bright shapes to reflect; a uniformly bright room just washes everything to white.
function StudioEnvironment() {
  return (
    <Environment resolution={256} frames={1}>
      {/* key softbox: top-right-front */}
      <Lightformer form="rect" intensity={5} color="#ffffff" scale={[9, 5, 1]} position={[4, 5, 5]} />
      {/* cool strip: left */}
      <Lightformer form="rect" intensity={3.2} color="#9bb8ff" scale={[2, 10, 1]} position={[-7, 2, 2]} />
      {/* rim: behind, blue-violet */}
      <Lightformer form="rect" intensity={4} color="#7a86ff" scale={[12, 3, 1]} position={[0, 2, -8]} />
      {/* warm top-back strip: gives the gold its highlights */}
      <Lightformer form="rect" intensity={3.5} color="#ffd9a0" scale={[8, 1.4, 1]} position={[0, 7, -3]} />
      {/* low cool bounce */}
      <Lightformer form="rect" intensity={0.8} color="#6070ff" scale={[10, 2, 1]} position={[0, -6, 3]} />
    </Environment>
  )
}

// ─── Lights ──────────────────────────────────────────────────────
// The environment supplies the broad reflections; these add the directional shape.
// The rim light takes on the accent colour of whichever bot is showing.
function Lights({ show }) {
  const rim = useRef(null)
  useFrame(() => {
    if (rim.current) rim.current.color.lerp(show.accent, 0.06)
  })
  return (
    <>
      <ambientLight intensity={0.02} />
      {/* Key: strong, top-right-front */}
      <directionalLight position={[3.5, 7, 5]} intensity={1.3} color="#ffffff" />
      {/* Rim: behind + below — silhouette halo */}
      <directionalLight ref={rim} position={[-1.5, -2, -7]} intensity={2.2} color="#8896ff" />
      {/* Fill: soft left — keeps shadow side readable */}
      <directionalLight position={[-5, 4, 2]} intensity={0.3} color="#c0ccff" />
      {/* Ground bounce: cold from below */}
      <pointLight position={[0, -3.5, 2]} intensity={0.6} color="#6070ff" distance={10} />
    </>
  )
}

// ─── Show rig: entry rise, auto-spin, drag, parallax, breathing ────────────────
function ShowRig({ show, onLoaded, isDragging, dragOffsetX, dragOffsetY }) {
  const groupRef = useRef(null)
  const baseY    = useRef(0)
  const entryT   = useRef(null)
  const pointer  = useRef({ x: 0, y: 0 })

  useEffect(() => {
    show.start(onLoaded)
    return () => show.dispose()
  }, [show, onLoaded])

  useFrame((state, delta) => {
    if (!groupRef.current) return
    pointer.current.x = state.pointer.x
    pointer.current.y = state.pointer.y

    // ── Entry: rise from y = -1 to 0 over ~1.8 s ──────────────
    if (entryT.current === null) entryT.current = state.clock.elapsedTime
    const elapsed  = state.clock.elapsedTime - entryT.current
    const progress = Math.min(elapsed / 1.8, 1)
    const eased    = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress)
    groupRef.current.position.y = -1.0 + eased * 1.0

    // ── Auto-spin (freezes during drag so angle doesn't jump) ──
    if (!isDragging.current) {
      baseY.current += delta * 0.14   // full revolution ≈ 45 s
    }

    if (isDragging.current) {
      // Instant response during drag — no smoothing lag
      groupRef.current.rotation.x = dragOffsetX.current
      groupRef.current.rotation.y = baseY.current + dragOffsetY.current
    } else {
      // Idle: smoothly track auto-spin + mouse parallax + drag residual
      const targetX = dragOffsetX.current + state.pointer.y * 0.12
      const targetY = baseY.current + dragOffsetY.current + state.pointer.x * 0.14
      groupRef.current.rotation.x +=
        (targetX - groupRef.current.rotation.x) * 0.04
      groupRef.current.rotation.y +=
        (targetY - groupRef.current.rotation.y) * 0.05
    }

    // ── Micro-breathing: barely perceptible scale oscillation ─
    const breath = 1 + Math.sin(state.clock.elapsedTime * 0.6) * 0.006
    groupRef.current.scale.setScalar(breath)

    show.update(Math.min(delta, 0.1), state.clock.elapsedTime, pointer.current)
  })

  return (
    <group ref={groupRef} position={[0, -1.0, 0]}>
      <primitive object={show.root} />
    </group>
  )
}

function Scene({ show, onLoaded, isDragging, dragOffsetX, dragOffsetY }) {
  return (
    <>
      <StudioEnvironment />
      <Lights show={show} />
      <ShowRig show={show} onLoaded={onLoaded} isDragging={isDragging} dragOffsetX={dragOffsetX} dragOffsetY={dragOffsetY} />
    </>
  )
}

// ─── Exported canvas wrapper ──────────────────────────────────────
export default function CinematicScene() {
  const desktop = useIsDesktop()
  // Only the desktop layout shows the scene: do not build the WebGL context or fetch the models otherwise.
  return desktop ? <HeroCanvas /> : null
}

function HeroCanvas() {
  const [loaded, setLoaded] = useState(false)
  const show = useMemo(() => new BotShow(BOTS), [])
  const handleLoaded = useCallback(() => setLoaded(true), [])

  // Drag state in refs — read by useFrame without causing re-renders
  const isDragging  = useRef(false)
  const lastPos     = useRef({ x: 0, y: 0 })
  const dragOffsetX = useRef(0)   // accumulated pitch (vertical drag)
  const dragOffsetY = useRef(0)   // accumulated yaw   (horizontal drag)

  const onPointerDown = (e) => {
    isDragging.current             = true
    lastPos.current                = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.cursor     = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  const onPointerMove = (e) => {
    if (!isDragging.current) return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    // Clamp pitch to ±0.65 rad so the model can't flip upside-down
    dragOffsetX.current = Math.max(-0.65, Math.min(0.65,
      dragOffsetX.current + dy * 0.006))
    dragOffsetY.current += dx * 0.007
    lastPos.current = { x: e.clientX, y: e.clientY }
  }

  const onPointerUp = () => {
    isDragging.current             = false
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
  }

  useEffect(() => () => {
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
  }, [])

  return (
    <motion.div
      className="w-full h-full"
      style={{ cursor: 'grab' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: loaded ? 1 : 0 }}
      transition={{ duration: 1.8, ease: [0.16, 1, 0.3, 1] }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <Canvas
        camera={{ position: [0, 0.1, 3.8], fov: 38 }}
        gl={{
          antialias: true,
          alpha: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.0,
          powerPreference: 'high-performance',
          stencil: false,
        }}
        dpr={[1, 1.5]}
        style={{ background: 'transparent' }}
      >
        <Scene
          show={show}
          onLoaded={handleLoaded}
          isDragging={isDragging}
          dragOffsetX={dragOffsetX}
          dragOffsetY={dragOffsetY}
        />
      </Canvas>
    </motion.div>
  )
}
