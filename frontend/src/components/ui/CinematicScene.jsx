import { useRef, useState, useEffect, useMemo, Suspense } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useFBX } from '@react-three/drei'
import { motion } from 'framer-motion'
import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────
//  ↓  SWAP THIS ONE IMPORT TO CHANGE THE HERO MODEL
// ─────────────────────────────────────────────────────────────────
import modelUrl from '../../source/Robot.fbx?url'
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
//  ↓  SCALE KNOB — increase to make the model larger in the scene
//     The model is auto-normalised to 2 units tall first; this
//     multiplier sits on top of that. 1.15 ≈ 15% larger than the
//     previous GLB hero.
// ─────────────────────────────────────────────────────────────────
const MODEL_SCALE = 1.15
// ─────────────────────────────────────────────────────────────────

// Pre-fetch the model before the component mounts
useFBX.preload(modelUrl)

// ─── 3-D model ───────────────────────────────────────────────────
function AgentModel({ onLoaded, isDragging, dragOffsetX, dragOffsetY }) {
  const fbx      = useFBX(modelUrl)
  const groupRef = useRef(null)
  const baseY    = useRef(0)
  const entryT   = useRef(null)

  /*
    Auto-fit — runs once when the FBX is in memory.
    Measures the real bounding box, computes a scale that maps
    the model's height to exactly 2.0 three.js units, then
    multiplies by MODEL_SCALE. Works regardless of whether the
    FBX was exported in cm, m, or inches.
  */
  const { fitScale, fitOffset } = useMemo(() => {
    const box  = new THREE.Box3().setFromObject(fbx)
    const size = new THREE.Vector3()
    const ctr  = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(ctr)

    const scale = size.y > 0
      ? (2.0 / size.y) * MODEL_SCALE
      : MODEL_SCALE

    return { fitScale: scale, fitOffset: ctr }
  }, [fbx])

  // Signal parent once geometry is measured
  useEffect(() => { onLoaded?.() }, [onLoaded])

  useFrame((state, delta) => {
    if (!groupRef.current) return

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
  })

  return (
    /*
      Outer group handles position animation (entry rise + parallax).
      Inner group re-centres the FBX and normalises its scale so
      swapping models is just changing the import at the top.
    */
    <group ref={groupRef} position={[0, -1.0, 0]}>
      <group
        scale={fitScale}
        position={[
          -fitOffset.x * fitScale,
          -fitOffset.y * fitScale,
          -fitOffset.z * fitScale,
        ]}
      >
        <primitive object={fbx} />
      </group>
    </group>
  )
}

// ─── Lights ──────────────────────────────────────────────────────
function Lights() {
  return (
    <>
      <ambientLight intensity={0.08} />
      {/* Key: strong, top-right-front */}
      <directionalLight position={[3.5, 7, 5]}  intensity={5.5} color="#ffffff" />
      {/* Rim: behind + below — silhouette halo */}
      <directionalLight position={[-1.5, -2, -7]} intensity={3.5} color="#8896ff" />
      {/* Fill: soft left — keeps shadow side readable */}
      <directionalLight position={[-5, 4, 2]}   intensity={0.7} color="#c0ccff" />
      {/* Ground bounce: cold from below */}
      <pointLight position={[0, -3.5, 2]} intensity={1.2} color="#6070ff" distance={10} />
    </>
  )
}

// ─── Scene ───────────────────────────────────────────────────────
function Scene({ onLoaded, isDragging, dragOffsetX, dragOffsetY }) {
  return (
    <>
      <Lights />
      <Suspense fallback={null}>
        <AgentModel
          onLoaded={onLoaded}
          isDragging={isDragging}
          dragOffsetX={dragOffsetX}
          dragOffsetY={dragOffsetY}
        />
      </Suspense>
    </>
  )
}

// ─── Exported canvas wrapper ──────────────────────────────────────
export default function CinematicScene() {
  const [loaded, setLoaded] = useState(false)

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
          toneMappingExposure: 1.1,
          powerPreference: 'high-performance',
          stencil: false,
        }}
        dpr={[1, 1.5]}
        style={{ background: 'transparent' }}
      >
        <Scene
          onLoaded={() => setLoaded(true)}
          isDragging={isDragging}
          dragOffsetX={dragOffsetX}
          dragOffsetY={dragOffsetY}
        />
      </Canvas>
    </motion.div>
  )
}
