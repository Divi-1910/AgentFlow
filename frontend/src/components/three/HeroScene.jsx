import { useRef, Suspense } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Float } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration } from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import * as THREE from 'three'

// Iridescent torus knot — the visual signature of AgentFlow
function KnotMesh() {
  const meshRef = useRef()

  useFrame((state) => {
    if (!meshRef.current) return
    const t = state.clock.elapsedTime
    // Deliberate, slow rotation on multiple axes — never the same angle twice
    meshRef.current.rotation.x = t * 0.10
    meshRef.current.rotation.y = t * 0.16
    meshRef.current.rotation.z = t * 0.04
  })

  return (
    <Float speed={1.4} floatIntensity={0.35} rotationIntensity={0.12}>
      <mesh ref={meshRef} scale={1.55}>
        <torusKnotGeometry args={[1, 0.3, 320, 32, 2, 3]} />
        <meshPhysicalMaterial
          color="#f8f8f8"
          metalness={1.0}
          roughness={0.02}
          iridescence={1.0}
          iridescenceIOR={2.1}
          iridescenceThicknessRange={[250, 1400]}
          envMapIntensity={5}
          clearcoat={1}
          clearcoatRoughness={0}
          reflectivity={1}
        />
      </mesh>
    </Float>
  )
}

function Scene() {
  return (
    <>
      {/* Dramatic three-point lighting */}
      <ambientLight intensity={0.04} />
      <directionalLight position={[5, 8, 4]}  intensity={5}   color="#ffffff" />
      <directionalLight position={[-5, -4, -6]} intensity={1.2} color="#818cf8" />
      <pointLight       position={[3, 2, 3]}   intensity={2.5} color="#c4b5fd" />
      <pointLight       position={[-2, -2, 2]} intensity={0.8} color="#6366f1" />

      {/* Studio HDRI for crisp reflections on the iridescent surface */}
      <Environment preset="studio" />

      <KnotMesh />

      <EffectComposer>
        {/* Soft bloom — makes highlights feel like real light */}
        <Bloom
          luminanceThreshold={0.55}
          luminanceSmoothing={0.9}
          intensity={0.6}
          blendFunction={BlendFunction.ADD}
        />
        {/* Subtle chromatic aberration — adds lens realism */}
        <ChromaticAberration
          offset={[0.0006, 0.0006]}
          blendFunction={BlendFunction.NORMAL}
        />
      </EffectComposer>
    </>
  )
}

export default function HeroScene({ className = '' }) {
  return (
    <div className={`w-full h-full ${className}`}>
      <Canvas
        camera={{ position: [0, 0, 5.5], fov: 40 }}
        gl={{
          antialias: true,
          alpha: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
        dpr={[1, 1.5]}
        style={{ background: 'transparent' }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>
    </div>
  )
}
