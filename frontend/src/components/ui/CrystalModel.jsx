import { useRef, Suspense } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Float, Environment, MeshTransmissionMaterial } from '@react-three/drei'
import * as THREE from 'three'

/*
  CrystalModel — floating glass icosahedron
  ─────────────────────────────────────────
  Geometry: IcosahedronGeometry detail=0 (20 flat triangular faces, 12 vertices).
  The flat faces are intentional — each face refracts light differently, creating
  the "cut crystal" look without any high-poly mesh.

  Material: MeshTransmissionMaterial (drei's improved glass shader).
  No postprocessing — the refractive highlights come entirely from the HDRI
  environment map, which is cheap to render.

  Performance budget:
  - Canvas: 260 × 320px, DPR capped at [1, 1.5]
  - ~240 triangles (icosa detail=0 × 2 sides)
  - Single environment texture blit, no render targets beyond the built-in
    transmission one (resolution=256 = tiny)
*/

function Crystal() {
  const meshRef = useRef(null)

  useFrame((_, delta) => {
    if (!meshRef.current) return
    // Lazy Y-axis rotation — full revolution in ~35 seconds
    meshRef.current.rotation.y += delta * 0.18
  })

  return (
    <Float speed={1.2} floatIntensity={0.28} rotationIntensity={0.07}>
      {/* Slight static tilt so the crystal shows its geometry well */}
      <group rotation={[0.22, 0, 0.1]}>
        <mesh ref={meshRef} castShadow={false} receiveShadow={false}>
          <icosahedronGeometry args={[1.28, 0]} />
          <MeshTransmissionMaterial
            // Glass-core properties
            transmission={1}
            roughness={0}
            thickness={1.8}
            ior={1.75}
            // Slight colour tint — pure white feels cold, this is barely off-white
            color="#f4f6ff"
            // Chromatic dispersion — very subtle rainbow fringing at edges
            chromaticAberration={0.025}
            // Render both sides for correct refraction
            backside
            backsideThickness={0.5}
            // Quality/perf: lower resolution = faster, still looks sharp at this size
            samples={4}
            resolution={256}
            // Subtle anisotropic blur softens the refraction slightly
            anisotropicBlur={0.05}
            // How strongly the environment reflects
            envMapIntensity={1.2}
            // Attenuates colour with depth (makes thick parts slightly tinted)
            attenuationDistance={3}
            attenuationColor="#e8eeff"
          />
        </mesh>

        {/* Ghost wireframe — shows the 20-face geometry at very low opacity */}
        <mesh>
          <icosahedronGeometry args={[1.31, 0]} />
          <meshBasicMaterial
            color="white"
            wireframe
            transparent
            opacity={0.035}
          />
        </mesh>
      </group>
    </Float>
  )
}

export default function CrystalModel() {
  return (
    /*
      The wrapper div intentionally has no background — the PixelSnow canvas
      behind it shows through the transparent R3F canvas, so the crystal
      appears to float inside the same space.
    */
    <div style={{ width: '100%', maxWidth: 260, aspectRatio: '1 / 1.1' }}>
      <Canvas
        camera={{ position: [0, 0, 4.2], fov: 34 }}
        gl={{
          antialias: true,
          alpha: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
          powerPreference: 'high-performance',
        }}
        dpr={[1, 1.5]}
        style={{ background: 'transparent' }}
      >
        <Suspense fallback={null}>
          {/* Very dim ambient — lets the environment do the heavy lifting */}
          <ambientLight intensity={0.06} />

          {/* Key light: slightly warm white from top-right */}
          <directionalLight
            position={[4, 7, 3]}
            intensity={2.5}
            color="#ffffff"
          />
          {/* Fill light: cold blue from bottom-left, adds depth */}
          <directionalLight
            position={[-4, -3, -4]}
            intensity={0.6}
            color="#b0b8ff"
          />

          {/* Studio HDRI: neutral, clean reflections — optimal for glass */}
          <Environment preset="studio" />

          <Crystal />
        </Suspense>
      </Canvas>
    </div>
  )
}
