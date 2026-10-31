import * as THREE from 'three'
import { createMotion } from './botMotion'

// ─────────────────────────────────────────────────────────────────────────────
//  BotShow: loads the bots on demand, holds one, transforms into the next, and
//  drives each bot's movement (botMotion.js). It is a plain controller (no React
//  state) so the per-frame work never triggers a re-render.
// ─────────────────────────────────────────────────────────────────────────────

const HOLD_SECONDS = 6.5          // how long a bot is shown before the next transformation
const TRANSITION_SECONDS = 2.3    // duration of the dissolve / re-materialise
const DISSOLVE_MAX = 1.45         // dissolve threshold at which everything is hidden
const MODEL_SCALE = 1.15          // on top of the auto-fit (height 2.0, width <= 2.1)
const MOTION_RAMP_SECONDS = 1.4   // role movement eases in while a bot materialises

const DISSOLVE_GLSL = /* glsl */ `
float dHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float dNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dHash(i), dHash(i + vec3(1,0,0)), f.x), mix(dHash(i + vec3(0,1,0)), dHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dHash(i + vec3(0,0,1)), dHash(i + vec3(1,0,1)), f.x), mix(dHash(i + vec3(0,1,1)), dHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`

// Patch every material of a bot with a noise dissolve whose uniforms are shared per bot.
function applyDissolve(materials, uniforms) {
  materials.forEach((m) => {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvDWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vDWorld;\nuniform float uDissolve;\nuniform float uOriginY;\nuniform float uInvH;\nuniform vec3 uEdge;\n${DISSOLVE_GLSL}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float dvv = 9.0;
          if (uDissolve > -0.5) {
            dvv = (vDWorld.y - uOriginY) * uInvH + dNoise(vDWorld * 6.0) * 0.28;
            if (dvv < uDissolve) discard;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (uDissolve > -0.5) totalEmissiveRadiance += uEdge * (1.0 - smoothstep(0.0, 0.09, dvv - uDissolve)) * 3.2;`)
    }
    m.customProgramCacheKey = () => 'bot-dissolve-v1'
    m.needsUpdate = true
  })
}

function hash01(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 1000) / 1000
}

function collectMaterials(group) {
  const mats = new Set()
  group.traverse((o) => {
    if (!o.isMesh) return
    ;(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m))
  })
  return mats
}

function disposeGroup(group) {
  collectMaterials(group).forEach((m) => m.dispose())
  group.traverse((o) => { if (o.isMesh) o.geometry?.dispose() })
}

// Fixes up translucent materials and records the glowing ones for the breathing pulse.
function prepareMaterials(group) {
  const emissive = []
  collectMaterials(group).forEach((m) => {
    if (m.transparent || m.opacity < 0.99) { m.depthWrite = false; m.side = THREE.DoubleSide }
    if (m.emissive && m.emissiveIntensity > 0.01 && m.emissive.r + m.emissive.g + m.emissive.b > 0.01) {
      emissive.push({ m, base: m.emissiveIntensity, phase: hash01(m.uuid) * 6 })
    }
  })
  return emissive
}

function breathe(emissive, t) {
  emissive.forEach((e) => { e.m.emissiveIntensity = e.base * (0.88 + 0.12 * Math.sin(t * 1.6 + e.phase)) })
}

const smooth = (x) => x * x * (3 - 2 * x)

export class BotShow {
  constructor(registry) {
    this.registry = registry
    this.root = new THREE.Group()
    this.entries = new Map()
    this.loading = new Map()
    this.index = -1
    this.state = 'loading'
    this.timer = 0
    this.lastT = null
    this.next = null
    this.accent = new THREE.Color(registry[0]?.accent ?? '#2b86ff')
    this.alive = true
    this._v = new THREE.Vector3()
    // with reduced motion the bots only sway gently; the transformation itself is unchanged
    this.reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

    const count = 220
    this.particleCount = count
    this.particleData = Array.from({ length: count }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0 }))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.035, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: this.accent.clone(),
    }))
    this.particles.frustumCulled = false
    this.root.add(this.particles)
  }

  async load(i) {
    if (this.entries.has(i)) return this.entries.get(i)
    if (this.loading.has(i)) return this.loading.get(i)
    const job = (async () => {
      const spec = this.registry[i]
      const mod = await spec.load()
      const group = mod.createBot()
      // motion first: it may give some parts their own material, which the dissolve patch must then include
      const motion = createMotion(group, spec.id, { reduced: this.reduced })
      const emissive = prepareMaterials(group)
      const box = new THREE.Box3().setFromObject(group)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const scale = Math.min(2.0 / size.y, 2.1 / size.x) * MODEL_SCALE
      const wrapper = new THREE.Group()
      wrapper.add(group)
      wrapper.scale.setScalar(scale)
      wrapper.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
      wrapper.visible = false
      const uniforms = {
        uDissolve: { value: -1 }, uOriginY: { value: 0 }, uInvH: { value: 1 / (size.y * scale) },
        uEdge: { value: new THREE.Color(spec.accent) },
      }
      applyDissolve(collectMaterials(group), uniforms)
      this.root.add(wrapper)
      const entry = { i, group, motion, emissive, age: 0, wrapper, uniforms, minY: box.min.y, scale, accent: new THREE.Color(spec.accent) }
      this.entries.set(i, entry)
      return entry
    })()
    this.loading.set(i, job)
    try { return await job } finally { this.loading.delete(i) }
  }

  start(onReady) {
    this.load(0).then((entry) => {
      if (!this.alive) return
      this.index = 0
      entry.wrapper.visible = true
      entry.age = 0
      this.accent.copy(entry.accent)
      this.state = 'hold'
      this.timer = 0
      onReady?.()
    }).catch((err) => console.error('hero bot failed to load', err))
  }

  _originY(entry) {
    entry.group.updateWorldMatrix(true, false)
    return this._v.set(0, entry.minY, 0).applyMatrix4(entry.group.matrixWorld).y
  }

  _beginParticles(color) {
    const mat = this.particles.material
    mat.color.copy(color)
    this.particleData.forEach((d) => {
      d.p.set((Math.random() - 0.5) * 1.3, -0.95 + Math.random() * 1.9, (Math.random() - 0.5) * 0.9)
      d.v.set((Math.random() - 0.5) * 0.25, 0.15 + Math.random() * 0.5, (Math.random() - 0.5) * 0.25)
      d.life = Math.random()
    })
  }

  update(dt, t, pointer) {
    if (this.state === 'loading') return
    const cur = this.entries.get(this.index)
    // the hold / transition timers follow the wall clock (capped), so a throttled frame rate does not slow the cycle
    const real = this.lastT === null ? dt : Math.min(t - this.lastT, 2)
    this.lastT = t
    this.timer += real

    if (this.state === 'hold') {
      if (this.registry.length > 1) {
        const nextIndex = (this.index + 1) % this.registry.length
        if (this.timer > 1.2 && !this.entries.has(nextIndex) && !this.loading.has(nextIndex)) {
          this.load(nextIndex).catch((err) => console.error('hero bot failed to load', err))
        }
        if (this.timer > HOLD_SECONDS && this.entries.has(nextIndex)) {
          this.next = this.entries.get(nextIndex)
          this.next.wrapper.visible = true
          this.next.age = 0
          this.next.uniforms.uDissolve.value = DISSOLVE_MAX
          cur.uniforms.uDissolve.value = 0
          this._beginParticles(this.next.accent)
          this.state = 'transition'
          this.timer = 0
        }
      }
    } else if (this.state === 'transition') {
      const p = Math.min(this.timer / TRANSITION_SECONDS, 1)
      const e = smooth(p)
      cur.uniforms.uDissolve.value = e * DISSOLVE_MAX
      this.next.uniforms.uDissolve.value = (1 - e) * DISSOLVE_MAX
      cur.uniforms.uEdge.value.copy(this.next.accent)
      this.next.uniforms.uEdge.value.copy(this.next.accent)
      this.accent.copy(cur.accent).lerp(this.next.accent, e)
      const pulse = 1 + 0.035 * Math.sin(Math.PI * p)
      cur.wrapper.scale.setScalar(cur.scale * pulse)
      this.next.wrapper.scale.setScalar(this.next.scale * pulse)
      this.particles.material.opacity = Math.sin(Math.PI * p) * 0.9
      if (p >= 1) {
        cur.wrapper.visible = false
        cur.uniforms.uDissolve.value = -1
        cur.wrapper.scale.setScalar(cur.scale)
        this.next.uniforms.uDissolve.value = -1
        this.next.wrapper.scale.setScalar(this.next.scale)
        this.particles.material.opacity = 0
        this.index = this.next.i
        this.next = null
        this.state = 'hold'
        this.timer = 0
      }
    }

    const active = this.state === 'transition' ? [cur, this.next] : [cur]
    active.forEach((entry) => {
      entry.age += real
      breathe(entry.emissive, t)
      // after the breathing pulse, so motion may drive the glow of individual parts
      entry.motion.update(entry.age, dt, pointer, smooth(Math.min(entry.age / MOTION_RAMP_SECONDS, 1)))
      entry.uniforms.uOriginY.value = this._originY(entry)
    })

    if (this.particles.material.opacity > 0.001) {
      const arr = this.particles.geometry.attributes.position.array
      this.particleData.forEach((d, k) => {
        d.p.addScaledVector(d.v, dt)
        arr[k * 3] = d.p.x; arr[k * 3 + 1] = d.p.y; arr[k * 3 + 2] = d.p.z
      })
      this.particles.geometry.attributes.position.needsUpdate = true
    }
  }

  dispose() {
    this.alive = false
    this.entries.forEach((entry) => disposeGroup(entry.group))
    this.entries.clear()
    this.particles.geometry.dispose()
    this.particles.material.dispose()
  }
}
