import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────────────────
//  botMotion: role-specific movement for the generated bots.
//
//  Every bot exposes its parts as pivot nodes (group.userData.sculptRuntime.nodes,
//  keyed by component id), so motion is plain rotations / positions / scales on
//  those pivots: rigid parts, no skinning. Channels are built once per bot and
//  write ABSOLUTE values from the captured rest pose, so motion never drifts and
//  amplitude 0 is exactly the rest pose. Nothing is allocated per frame.
//
//  Timing: `t` is the bot's local time since it started to materialise, so every
//  orbit / hop / gesture starts from the rest pose and nothing jumps when the
//  amplitude ramps in.
//
//  Pivot facts used below (from the generator): a leaf mesh is centred on its
//  pivot; arms and fingers hang along -Y with the front at +Z, so a negative
//  rotation.x swings a limb forward and a positive rotation.z swings it toward +X
//  (the character's left). Props held by a hand or manipulator grip are separate
//  top-level parts, so they are made to follow that grip (see `hold`).
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2
const _v = new THREE.Vector3()

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(Math.max(x, 0), 1))
// 1 inside [a, b], easing in and out over `ramp` seconds at both ends
const window01 = (x, a, b, ramp) => smooth((x - a) / ramp) * (1 - smooth((x - (b - ramp)) / ramp))
// a short periodic blip, period 1 in x
const pulse = (x) => { const s = Math.sin(x * TAU); return s > 0 ? s * s * s * s : 0 }
const wrap = (x, p) => ((x % p) + p) % p
// robotic move: hold at 0, ease to 1, hold, ease back (period p seconds)
const shuttle = (t, p, phase = 0) => {
  const u = wrap(t / p + phase, 1)
  if (u < 0.3) return 0
  if (u < 0.45) return ease((u - 0.3) / 0.15)
  if (u < 0.8) return 1
  return 1 - ease((u - 0.8) / 0.2)
}

function hash01(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 1000) / 1000
}

// Bounding box of a pivot's own meshes, in the pivot's local space.
function localBox(node) {
  const box = new THREE.Box3()
  node.children.forEach((child) => {
    if (!child.isMesh) return
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox()
    child.updateMatrix()
    box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrix))
  })
  return box
}

export function createMotion(group, botId, { reduced = false } = {}) {
  const runtime = group.userData.sculptRuntime ?? {}
  const N = runtime.nodes ?? {}
  const M = runtime.meshes ?? {}
  const rootNode = N.root ?? group
  const ids = Object.keys(N)
  const chans = new Map()          // node -> { n, b (rest pose), fn }; runs in insertion order
  const pre = []                   // per-frame context hooks (look targets, gesture envelopes)
  const ampScale = reduced ? 0.45 : 1
  const ctx = { t: 0, dt: 0, a: 0, sp: { x: 0, y: 0 }, lookYaw: 0, lookPitch: 0, lookRoll: 0, scan: 1, gl: 0, gr: 0 }

  const restOf = (n) => ({ p: n.position.clone(), r: n.rotation.clone(), s: n.scale.clone() })
  const set = (idOrNode, fn) => {
    const n = typeof idOrNode === 'string' ? N[idOrNode] : idOrNode
    if (!n) return null
    const prev = chans.get(n)
    const ch = { n, b: prev ? prev.b : restOf(n), fn }
    chans.set(n, ch)
    return ch
  }
  const each = (re, cb) => ids.forEach((id) => { const m = id.match(re); if (m) cb(N[id], m, id) })
  const isTop = (n) => n.parent === rootNode || n.parent === group

  // Origin of a node in the space of the root pivot (where the props live), from local matrices only.
  const rootPos = (node, out) => {
    out.set(0, 0, 0)
    for (let p = node; p && p !== rootNode && p !== group; p = p.parent) { p.updateMatrix(); out.applyMatrix4(p.matrix) }
    return out
  }

  // A prop held by one or more grips follows their mean displacement, so it stays in the hand.
  // Must be declared after every channel that moves those grips; `extra` may add its own motion.
  const hold = (propId, gripIds, extra = null) => {
    const grips = gripIds.map((g) => N[g]).filter(Boolean)
    if (!N[propId] || !grips.length) return null
    const rest = grips.map((g) => rootPos(g, new THREE.Vector3()))
    return set(propId, (n, b, c) => {
      n.position.copy(b.p)
      for (let i = 0; i < grips.length; i += 1) n.position.add(rootPos(grips[i], _v).sub(rest[i]).divideScalar(grips.length))
      if (extra) extra(n, b, c)
    })
  }

  // Make a channel rotate / scale about a point of the part instead of its centre:
  // (fx, fy, fz) in [-1, 1] picks the point inside the part's box (-1 = min side).
  const anchor = (ch, fx, fy, fz) => {
    if (!ch) return
    const box = localBox(ch.n)
    if (box.isEmpty()) return
    const c = box.getCenter(new THREE.Vector3()), h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5)
    ch.b.anchor = new THREE.Vector3(c.x + h.x * fx, c.y + h.y * fy, c.z + h.z * fz)
    ch.b.anchorP = ch.b.anchor.clone().multiply(ch.b.s).applyEuler(ch.b.r).add(ch.b.p)
    const fn = ch.fn
    ch.fn = (n, b, cx) => {
      fn(n, b, cx)
      n.position.copy(b.anchorP).sub(_v.copy(b.anchor).multiply(n.scale).applyEuler(n.rotation))
    }
  }

  // Give one part its own copy of its material so its glow can be driven alone.
  const ownMaterial = (id) => {
    const mesh = M[id]
    if (!mesh || Array.isArray(mesh.material) || !mesh.material.emissive) return null
    mesh.material = mesh.material.clone()
    return { m: mesh.material, base: mesh.material.emissiveIntensity }
  }

  // gentle hover used by floating props: floatY from the rest position, bob on top of a held position
  const floatY = (n, b, c, ph, amp = 0.012) => {
    n.position.y = b.p.y + c.a * amp * Math.sin(c.t * 0.9 + ph)
    n.position.x = b.p.x + c.a * amp * 0.45 * Math.sin(c.t * 0.55 + ph * 0.7)
  }
  const bob = (n, c, ph, amp = 0.012) => {
    n.position.y += c.a * amp * Math.sin(c.t * 0.9 + ph)
    n.position.x += c.a * amp * 0.45 * Math.sin(c.t * 0.55 + ph * 0.7)
  }

  // Move around the body's vertical axis, keeping the same face toward the body.
  // speed (rad/s) gives a full orbit; arc > 0 swings +/- arc radians at `speed` rad/s instead.
  // radius eases the orbit to that radius; bulge widens it behind the body (clear of back fins).
  const orbit = (n, speed, { arc = 0, bob = 0.012, radius = 0, bulge = 0 } = {}) => set(n, (n, b, c) => {
    if (b.rad === undefined) { b.rad = Math.hypot(b.p.x, b.p.z); b.th0 = Math.atan2(b.p.z, b.p.x) }
    const d = (arc ? arc * Math.sin(c.t * speed) : c.t * speed) * c.a
    const th = b.th0 + d
    const r = b.rad + c.a * ((radius ? radius - b.rad : 0) + bulge * smooth(-Math.sin(th) / 0.35))
    n.position.x = Math.cos(th) * r
    n.position.z = Math.sin(th) * r
    n.position.y = b.p.y + c.a * bob * Math.sin(c.t * 1.1 + b.th0 * 3)
    n.rotation.y = b.r.y - d
  })

  // ── generic: live panel content (chart bars and text lines shrink and regrow inside their panel) ──
  if (!reduced) {
    each(/-bar(\d+)$/, (n, m, id) => {
      const i = +m[1], ph = hash01(id) * TAU
      anchor(set(n, (n, b, c) => { n.scale.y = b.s.y * (1 - c.a * 0.45 * (0.5 + 0.5 * Math.sin(c.t * 1.9 + i * 0.9 + ph))) }), 0, -1, 0)
    })
    each(/-line(\d+)$/, (n, m, id) => {
      const i = +m[1], ph = hash01(id) * TAU
      anchor(set(n, (n, b, c) => { n.scale.x = b.s.x * (1 - c.a * 0.4 * (0.5 + 0.5 * Math.sin(c.t * 1.3 - i * 0.8 + ph))) }), -1, 0, 0)
    })
  }

  // ── generic: humanoid body (weight shift, breathing, arm swing, fingers) ──
  const bodySway = (amp = 1, freq = 0.55, yaw = 0.06) => {
    set('pelvis', (n, b, c) => {
      const w = Math.sin(c.t * freq)
      n.rotation.z = b.r.z + c.a * 0.02 * amp * w
      n.position.x = b.p.x + c.a * 0.006 * amp * w
      n.position.y = b.p.y + c.a * 0.004 * Math.sin(c.t * 1.1)
    })
    for (const s of ['l', 'r']) set(`thigh-${s}`, (n, b, c) => { n.rotation.z = b.r.z - c.a * 0.02 * amp * Math.sin(c.t * freq) })
    set('chest', (n, b, c) => {
      n.rotation.x = b.r.x + c.a * 0.016 * Math.sin(c.t * 1.1)
      n.rotation.z = b.r.z - c.a * 0.026 * amp * Math.sin(c.t * freq)
      n.rotation.y = b.r.y + c.a * yaw * Math.sin(c.t * 0.33)
    })
  }
  // An arm that idles (opposite-phase swing) and blends into a pose + wave while env(c) is 1.
  const arm = (s, env = null, { raise = 0, out = 0, flex = 0, wave = 0, rate = 7, swing = 1 } = {}) => {
    const sg = s === 'l' ? 1 : -1, ph = s === 'l' ? 0 : Math.PI
    set(`upper-arm-${s}`, (n, b, c) => {
      const e = env ? env(c) * c.a : 0, idle = (c.a - e) * swing
      n.rotation.x = b.r.x + idle * 0.06 * Math.sin(c.t * 0.8 + ph) - e * raise
      n.rotation.z = b.r.z + sg * (idle * (0.025 + 0.02 * Math.sin(c.t * 0.6 + ph)) + e * out)
    })
    set(`forearm-${s}`, (n, b, c) => {
      const e = env ? env(c) * c.a : 0, idle = (c.a - e) * swing
      n.rotation.x = b.r.x - idle * (0.06 + 0.05 * Math.sin(c.t * 0.8 + ph + 0.7)) - e * flex
      n.rotation.z = b.r.z + sg * e * wave * Math.sin(c.t * rate)
    })
  }
  const fingersIdle = (s) => {
    const ph = s === 'l' ? 0 : 1.9
    ;['thumb', 'index', 'middle', 'ring', 'little'].forEach((f, k) => set(`${f}-${s}-1`, (n, b, c) => {
      n.rotation.x = b.r.x - c.a * 0.14 * (0.5 + 0.5 * Math.sin(c.t * 0.9 + k * 0.45 + ph))
    }))
  }
  if (N.chest) bodySway()
  if (N['upper-arm-l']) { arm('l'); arm('r'); fingersIdle('l'); fingersIdle('r') }

  // ── role-specific movement ─────────────────────────────────────────────────
  const roles = {
    base() {
      // relaxed scan; shortly after it materialises it raises the right hand and waves
      const env = (c) => window01(wrap(c.t, 14), 2.6, 6.2, 0.8)
      pre.push((c) => { const e = env(c) * c.a; c.lookYaw -= 0.2 * e; c.lookPitch -= 0.04 * e; c.scan = 1 - env(c) })
      arm('r', env, { raise: 1.25, out: 0.32, flex: 1.2, wave: 0.38, rate: 7.5 })
    },

    researcher() {
      // manipulators: a travelling wave down each chain; the free ones reach out one at a time,
      // the ones holding panels / the book move gently and carry what they hold
      bodySway(0.4, 0.5, 0.015)        // a hovering column: the torso barely sways, the arms do the moving
      const held = { A1: 'prop-panel-1', A3: 'prop-panel-2', A4: 'prop-panel-3', A5: 'prop-book', B1: 'prop-panel-7' }
      const free = ['A2', 'A6']        // B2 is also empty-handed but sits beside the globe, so it only sways
      each(/^reach-rod-([A-Z]\d)-(\d)$/, (n, m) => {
        const k = free.indexOf(m[1]), ph = hash01(m[1]) * TAU, i = +m[2]
        const wave = held[m[1]] ? 0.04 : 0.1
        set(n, (n, b, c) => {
          const sg = Math.sign(b.p.x) || 1
          const reach = k >= 0 && i === 0 ? window01(wrap(c.t - 1.2 - k * 1.6, free.length * 1.6), 0, 2.2, 0.8) : 0
          const w = c.t * 0.85 + ph + i * 0.9
          n.rotation.z = b.r.z + c.a * (wave * Math.sin(w) + sg * 0.32 * reach)
          n.rotation.x = b.r.x + c.a * wave * 0.7 * Math.sin(w * 0.8 + 1.3)
        })
      })
      Object.entries(held).forEach(([k, prop]) => hold(prop, [`reach-grip-${k}`]))
      // the globe rests on the book, so it follows the same grip; its rings rock like a gyroscope
      // (spinning the plain sphere would only sweep the rings through the arm holding the book)
      hold('prop-globe', ['reach-grip-A5'])
      each(/^prop-globe-ring(\d)$/, (n, m) => set(n, (n, b, c) => { n.rotation.x = b.r.x + c.a * 0.16 * Math.sin(c.t * (0.7 + 0.25 * +m[1]) + +m[1] * 2) }))
      each(/^prop-book-page(\d)$/, (n, m) => {
        const k = +m[1], sg = Math.sign(n.position.x) || 1
        anchor(set(n, (n, b, c) => {
          const lift = 0.5 * window01(wrap(c.t - 1 - k * 2.2, 4.4), 0, 1.4, 0.5)
          n.rotation.z = b.r.z + sg * c.a * (0.06 * Math.sin(c.t * 2.4 + k * 1.3) + lift)
        }), -sg, 0, 0)
      })
      set('hover-base', (n, b, c) => {
        n.position.y = b.p.y + c.a * 0.012 * Math.sin(c.t * 1.2)
        n.rotation.z = b.r.z + c.a * 0.018 * Math.sin(c.t * 0.7)
        n.rotation.x = b.r.x + c.a * 0.012 * Math.sin(c.t * 0.9)
      })
      set('hover-base-glow', (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.07 * Math.sin(c.t * 2.2))) })
      set('prop-sat', (n, b, c) => { n.rotation.y = b.r.y + c.a * 0.5 * Math.sin(c.t * 0.6); floatY(n, b, c, 2.1, 0.02) })
    },

    coder() {
      // eyes on the keys, both hands typing, keys pressing and lighting in a rolling sequence
      pre.push((c) => { c.lookPitch += 0.14 * c.a; c.scan = 0.4 })
      bodySway(0.7, 0.55, 0.012)                             // focused: the torso hardly turns while typing
      for (const s of ['l', 'r']) {
        const ph = s === 'l' ? 0 : 1.7
        // the upper arms stay steady so the hands stay over the keys
        set(`upper-arm-${s}`, (n, b, c) => { n.rotation.x = b.r.x + c.a * 0.015 * Math.sin(c.t * 0.7 + ph) })
        set(`forearm-${s}`, (n, b, c) => { n.rotation.x = b.r.x - c.a * (0.04 + 0.03 * Math.sin(c.t * 8.5 + ph)) })
        set(`hand-${s}`, (n, b, c) => { n.rotation.x = b.r.x + c.a * 0.07 * Math.sin(c.t * 8.5 + ph + 0.6) })
        ;['index', 'middle', 'ring'].forEach((f, k) => set(`${f}-${s}-1`, (n, b, c) => {
          n.rotation.x = b.r.x - c.a * 0.38 * pulse(c.t * 3.1 + k * 0.37 + ph * 0.3)
        }))
      }
      each(/^prop-keys-key(\d)$/, (n, m, id) => {
        const k = +m[1], glow = ownMaterial(id)
        set(n, (n, b, c) => {
          const hit = pulse(c.t * 0.9 - k * 0.13)
          n.position.y = b.p.y - c.a * 0.006 * hit          // keyboard local +Y faces the bot
          if (glow) glow.m.emissiveIntensity = glow.base * (0.55 + 1.3 * c.a * hit)
        })
      })
      hold('prop-keys', ['upper-arm-l', 'upper-arm-r'])     // the keyboard rides with the shoulders, not the typing
      for (const g of ['prop-tablet-lt', 'prop-tablet-gt', 'prop-tablet-slash']) {
        set(g, (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.18 * pulse(c.t * 0.6))) })
      }
      each(/^prop-shard-(\d)$/, (n, m) => set(n, (n, b, c) => { n.rotation.y = b.r.y + c.t * 0.9; floatY(n, b, c, +m[1] * 2.3, 0.02) }))
    },

    creator() {
      // the stylus hand traces loops in the air; ribbons ripple; the palette wheel turns
      pre.push((c) => { c.lookYaw += 0.25 * c.a; c.lookPitch += 0.06 * c.a })
      bodySway(1.7, 0.7)
      set('upper-arm-l', (n, b, c) => {
        const w = c.t * 1.5
        n.rotation.x = b.r.x - c.a * (0.14 + 0.13 * Math.sin(w))
        n.rotation.z = b.r.z + c.a * (0.04 + 0.1 * Math.cos(w))
      })
      set('forearm-l', (n, b, c) => { n.rotation.x = b.r.x - c.a * (0.2 + 0.12 * Math.sin(c.t * 1.5 + 0.8)) })
      set('hand-l', (n, b, c) => { n.rotation.z = b.r.z + c.a * 0.12 * Math.sin(c.t * 3 + 0.4) })
      each(/^ribbon-(\d)$/, (n, m) => {
        const k = +m[1]
        set(n, (n, b, c) => {
          n.rotation.z = b.r.z + c.a * 0.08 * Math.sin(c.t * 0.9 + k * 1.1)
          n.rotation.x = b.r.x + c.a * 0.05 * Math.sin(c.t * 0.7 + k * 0.8)
          n.rotation.y = b.r.y + c.a * 0.06 * Math.sin(c.t * 0.45 + k)
        })
      })
      const dots = ids.filter((id) => /^prop-palette-dot\d$/.test(id)).map((id) => N[id])
      if (dots.length) {
        const cx = dots.reduce((s, n) => s + n.position.x, 0) / dots.length
        const cy = dots.reduce((s, n) => s + n.position.y, 0) / dots.length
        dots.forEach((dot) => set(dot, (n, b, c) => {
          if (b.rad === undefined) { b.rad = Math.hypot(b.p.x - cx, b.p.y - cy); b.th0 = Math.atan2(b.p.y - cy, b.p.x - cx) }
          const th = b.th0 + c.t * 0.7 * c.a
          n.position.x = cx + Math.cos(th) * b.rad
          n.position.y = cy + Math.sin(th) * b.rad
        }))
      }
      // the palette floats a little further out, clear of the skirt petals and ribbons beside it
      set('prop-palette', (n, b, c) => {
        floatY(n, b, c, 0.8)
        n.position.x += c.a * 0.045
        n.position.z = b.p.z + c.a * 0.05
        n.rotation.y = b.r.y + c.a * 0.05 * Math.sin(c.t * 0.5)
      })
      set('prop-stylus-tip', (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.35 * (0.5 + 0.5 * Math.sin(c.t * 3)))) })
      each(/^petal-([abc])-([lr])$/, (n, m) => {
        const k = 'abc'.indexOf(m[1]), sg = m[2] === 'l' ? 1 : -1
        set(n, (n, b, c) => {
          n.rotation.x = b.r.x + c.a * 0.06 * Math.sin(c.t * 1.2 + k)
          n.rotation.z = b.r.z + sg * c.a * 0.045 * Math.sin(c.t * 0.9 + k * 0.7)
        })
      })
    },

    strategist() {
      // both hands hold the board, which sways with them; the pieces hop and turn in turn,
      // a scan sweeps the board, the cape billows, and every few seconds it studies the board
      const ponder = (c) => window01(wrap(c.t, 6.5), 2.2, 4.6, 0.6)
      pre.push((c) => { c.lookPitch += 0.18 * ponder(c) * c.a; c.lookRoll += 0.06 * ponder(c) * c.a; c.scan = 1 - ponder(c) })
      arm('l', null, { swing: 0.15 })
      arm('r', null, { swing: 0.15 })
      hold('prop-board', ['hand-l', 'hand-r'])
      each(/^prop-(rook|pawn|bishop|queen)-(\d)$/, (n, m, id) => {
        const off = hash01(id) * 3.2
        // pieces floating close to the body step out a little: beside the head they move outward so
        // the turning head clears them, in front of the chest they move forward
        const p = n.position, r = Math.hypot(p.x, p.z), board = N['prop-board']?.position
        const near = r < 0.3
        // a piece standing at the board's edge steps off it, so its hop does not pass through the board
        const onEdge = board && Math.abs(p.x - board.x) < 0.42 && Math.abs(p.y - board.y) < 0.2 && !near
        const nx = near && p.y > 1.7 ? (0.06 * p.x) / Math.max(r, 0.01) : onEdge ? 0.06 * Math.sign(p.x - board.x) : 0
        const nz = near ? (p.y > 1.7 ? (0.06 * p.z) / Math.max(r, 0.01) : 0.04) : 0
        set(n, (n, b, c) => {
          const P = 3.2, tt = c.t + off, u = wrap(tt, P) / P
          const hop = u < 0.22 ? Math.sin((u / 0.22) * Math.PI) : 0
          n.position.x = b.p.x + c.a * nx
          n.position.z = b.p.z + c.a * nz
          n.position.y = b.p.y + c.a * (0.05 * hop + 0.006 * Math.sin(c.t * 1.1 + off))
          n.rotation.y = b.r.y + c.a * (Math.floor(tt / P) + smooth(u / 0.22)) * 0.9
        })
      })
      each(/^prop-board-v(\d)$/, (n, m) => set(n, (n, b, c) => { n.scale.x = b.s.x * (1 + c.a * 2.4 * pulse(c.t * 0.42 - +m[1] * 0.055)) }))
      each(/^prop-board-h(\d)$/, (n, m) => set(n, (n, b, c) => { n.scale.y = b.s.y * (1 + c.a * 2.4 * pulse(c.t * 0.42 - 0.5 - +m[1] * 0.09)) }))
      each(/^cape-([abc])-([lr])$/, (n, m) => {
        const k = 'abc'.indexOf(m[1]), sg = m[2] === 'l' ? 1 : -1
        set(n, (n, b, c) => {
          n.rotation.x = b.r.x - c.a * (0.04 + 0.05 * Math.sin(c.t * 1.2 + k * 0.7 + sg * 0.5))
          n.rotation.z = b.r.z + sg * c.a * 0.03 * Math.sin(c.t * 0.8 + k)
        })
      })
    },

    assistant() {
      // friendly: the open hands present the card and mail tiles, lifting them in turn (the right one
      // with a little wave of the wrist); the head tilts, drones orbit, and the other tiles make room
      const offerR = (c) => window01(wrap(c.t, 9), 1.6, 4.8, 0.7)
      const offerL = (c) => window01(wrap(c.t, 9), 5.0, 8.2, 0.8)
      pre.push((c) => { c.lookRoll += 0.1 * Math.sin(c.t * 0.8) * c.a; c.gr = offerR(c) * c.a; c.gl = offerL(c) * c.a })
      set('pelvis', (n, b, c) => {
        n.position.y = b.p.y + c.a * 0.02 * Math.sin(c.t * 1.1)
        n.rotation.z = b.r.z + c.a * 0.02 * Math.sin(c.t * 0.6)
      })
      // the lift comes from the shoulder, so a tile in front of the forearm moves with the whole arm
      arm('r', offerR, { raise: 0.35, out: 0.08, flex: 0.1, swing: 0.4 })
      arm('l', offerL, { raise: 0.35, out: 0.08, flex: 0.1, swing: 0.4 })
      set('hand-r', (n, b, c) => { n.rotation.z = b.r.z + c.gr * 0.3 * Math.sin(c.t * 6.5) })
      hold('prop-icon-card', ['hand-r'], (n, b, c) => { n.scale.setScalar(b.s.x * (1 + 0.12 * c.gr)) })
      hold('prop-icon-mail', ['hand-l'], (n, b, c) => { n.scale.setScalar(b.s.x * (1 + 0.12 * c.gl)) })
      orbit(N['prop-orb-1'], 0.22, { radius: 0.42 })
      orbit(N['prop-orb-2'], 0.5, { arc: 0.35 })
      orbit(N['prop-orb-4'], 0.24, { bob: 0.02 })
      set('prop-wheel', (n, b, c) => {
        n.rotation.x = b.r.x + c.a * 0.05 * Math.sin(c.t * 1.2)
        n.rotation.z = b.r.z + c.a * 0.05 * Math.cos(c.t * 1.2)
        n.position.y = b.p.y + c.a * 0.012 * Math.sin(c.t * 1.4)
        n.position.z = b.p.z + c.a * 0.025                     // a little clearance from the pod while it wobbles
      })
      set('prop-tray', (n, b, c) => { n.position.y = b.p.y + c.a * 0.012 * Math.sin(c.t * 1.2); n.rotation.z = b.r.z + c.a * 0.04 * Math.sin(c.t * 0.9) })
      each(/^prop-leaf-(\d)$/, (n, m) => set(n, (n, b, c) => { n.rotation.z = b.r.z + c.a * 0.08 * Math.sin(c.t * 1.6 + +m[1]) }))
      each(/^prop-(icon|panel)-[a-z0-9]+(?:-[a-z0-9]+)?$/, (n, m, id) => {
        if (!isTop(n) || chans.has(n)) return
        const k = hash01(id) * 4.5
        const len = Math.hypot(n.position.x, n.position.z) || 1
        const ox = n.position.x / len, oz = n.position.z / len
        set(n, (n, b, c) => {
          const push = 0.13 * (b.p.x < 0 ? c.gr : c.gl)       // step aside for the hand lifting nearby
          n.scale.setScalar(b.s.x * (1 + c.a * 0.18 * pulse((c.t + k) / 4.5)))
          floatY(n, b, c, k)
          n.position.x += ox * push
          n.position.z = b.p.z + oz * push
        })
      })
      set('pod-glow', (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.15 * Math.sin(c.t * 2))) })
    },

    social() {
      // a little dance carrying the chart (left hand) and the play tile (right hand); the other
      // notification tiles sweep around the body together and pop; the cameras watch the cursor
      bodySway(2.0, 0.9)
      for (const s of ['l', 'r']) {
        const sg = s === 'l' ? 1 : -1, ph = s === 'l' ? 0 : Math.PI
        set(`upper-arm-${s}`, (n, b, c) => {
          n.rotation.z = b.r.z + sg * c.a * 0.035 * Math.sin(c.t * 1.8 + ph)
          n.rotation.x = b.r.x - c.a * 0.08 * Math.sin(c.t * 0.9 + ph)
        })
      }
      hold('prop-panel-chart', ['hand-l'])
      hold('prop-icon-play', ['hand-r'], (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.15 * pulse(c.t / 3))) })
      // one shared swing, so the tiles never pass through each other; wider behind the fins
      each(/^prop-icon-[a-z0-9]+$/, (n, m, id) => {
        if (!isTop(n) || chans.has(n)) return
        const k = hash01(id) * 4
        const ch = orbit(n, 0.5, { arc: 0.6, bob: 0.014, bulge: 0.22 })
        const orbitFn = ch.fn
        ch.fn = (n, b, c) => { orbitFn(n, b, c); n.scale.setScalar(b.s.x * (1 + c.a * 0.22 * pulse((c.t + k) / 4))) }
      })
      // the cameras turn toward the cursor: camera 1 hovers over the chart and rides along with it,
      // camera 2 is tethered by a cord, so it turns less and stays put
      hold('prop-cam-1', ['hand-l'], (n, b, c) => {
        n.rotation.y = b.r.y + c.sp.x * 0.7
        n.rotation.x = b.r.x - c.sp.y * 0.35
        n.position.y += c.a * 0.01 * Math.sin(c.t * 1.3)
      })
      set('prop-cam-2', (n, b, c) => {
        n.rotation.y = b.r.y + c.sp.x * 0.2
        n.rotation.x = b.r.x - c.sp.y * 0.1
      })
      each(/^fin-([a-d])-([lr])$/, (n, m) => {
        const k = 'abcd'.indexOf(m[1]), sg = m[2] === 'l' ? 1 : -1
        set(n, (n, b, c) => {
          n.rotation.x = b.r.x + c.a * 0.07 * Math.sin(c.t * 1.6 + k * 0.8)
          n.rotation.z = b.r.z + sg * c.a * 0.06 * Math.sin(c.t * 1.3 + k)
        })
      })
    },

    automation() {
      // industrial: eased hold-and-move work cycles that carry the held tools, a robotic head scan
      pre.push((c) => { c.lookYaw += c.a * 0.38 * (shuttle(c.t, 5.6, 0.1) * 2 - 1); c.scan = 0 })
      set('pelvis', (n, b, c) => { n.position.y = b.p.y + c.a * 0.015 * Math.sin(c.t * 1.1) })
      each(/^reach-rod-([A-Z]\d)-(\d)$/, (n, m) => {
        const ph = hash01(m[1]), i = +m[2]
        set(n, (n, b, c) => {
          const s = shuttle(c.t, 5.2, ph) * c.a
          const sg = Math.sign(b.p.x) || 1
          if (i === 0) n.rotation.z = b.r.z + sg * 0.22 * s
          else if (i === 1) n.rotation.z = b.r.z - sg * 0.3 * s
          else n.rotation.x = b.r.x - 0.25 * s
        })
      })
      hold('prop-gear-box', ['reach-grip-R1'])
      hold('prop-icon-gear', ['reach-grip-L1'])
      hold('prop-crate', ['reach-grip-B2'])
      hold('prop-cannon', ['reach-grip-L2'], (n, b, c) => { n.rotation.y = b.r.y + c.a * 0.22 * (shuttle(c.t, 6.2, 0.55) * 2 - 1) })
      set('prop-gear-1', (n, b, c) => { n.rotation.z = b.r.z + c.t * 1.3 })
      set('prop-icon-gear-g', (n, b, c) => { n.rotation.z = b.r.z - c.t * 0.9 })
      set('prop-track-ring', (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.12 * Math.sin(c.t * 2.4))) })
      set('rotor-base-glow', (n, b, c) => { n.scale.setScalar(b.s.x * (1 + c.a * 0.08 * Math.sin(c.t * 2.6))) })
    },
  }
  if (!reduced) roles[botId]?.()

  // ── generic: every other top-level prop floats; one beside a shoulder also rides its sway ──
  const shoulders = ['upper-arm-l', 'upper-arm-r'].filter((k) => N[k]).map((k) => [k, rootPos(N[k], new THREE.Vector3())])
  ids.forEach((id) => {
    const n = N[id]
    if (!id.startsWith('prop-') || !isTop(n) || chans.has(n)) return
    const ph = hash01(id) * TAU, amp = 0.01 + hash01(`${id}a`) * 0.008
    const turn = (n, b, c) => { n.rotation.y = b.r.y + c.a * 0.04 * Math.sin(c.t * 0.4 + ph) }
    const near = shoulders.find(([, p]) => p.distanceTo(n.position) < 0.35)
    if (near) {
      // ...and keeps 3 cm more clearance from the shoulder armour, which tilts with the chest
      const len = Math.hypot(n.position.x, n.position.z) || 1
      const ox = (0.03 * n.position.x) / len, oz = (0.03 * n.position.z) / len
      hold(id, [near[0]], (n, b, c) => { bob(n, c, ph, amp); n.position.x += c.a * ox; n.position.z += c.a * oz; turn(n, b, c) })
    } else set(n, (n, b, c) => { floatY(n, b, c, ph, amp); turn(n, b, c) })
  })

  // ── head: damped look-around that follows the cursor ───────────────────────
  if (N.head) {
    const st = { y: 0, x: 0, z: 0 }
    set('head', (n, b, c) => {
      const scan = c.scan * (0.22 * Math.sin(c.t * 0.31) + 0.08 * Math.sin(c.t * 0.83 + 1))
      const ty = c.sp.x * 0.38 + c.a * scan + c.lookYaw
      const tx = -c.sp.y * 0.16 + c.a * 0.04 * Math.sin(c.t * 0.5) + c.lookPitch
      const k = 1 - Math.exp(-c.dt * 5)
      st.y += (ty - st.y) * k
      st.x += (tx - st.x) * k
      st.z += (c.lookRoll - st.z) * k
      n.rotation.y = b.r.y + st.y
      n.rotation.x = b.r.x + st.x
      n.rotation.z = b.r.z + st.z
    })
  }
  const channels = [...chans.values()]

  return {
    // t: local seconds since the bot began to appear; amp: 0..1 ramp; pointer: normalised -1..1
    update(t, dt, pointer, amp) {
      const k = 1 - Math.exp(-dt * 6)
      ctx.sp.x += (pointer.x - ctx.sp.x) * k
      ctx.sp.y += (pointer.y - ctx.sp.y) * k
      ctx.t = t
      ctx.dt = dt
      ctx.a = amp * ampScale
      ctx.lookYaw = 0
      ctx.lookPitch = 0
      ctx.lookRoll = 0
      ctx.scan = 1
      ctx.gl = 0
      ctx.gr = 0
      for (let i = 0; i < pre.length; i += 1) pre[i](ctx)
      for (let i = 0; i < channels.length; i += 1) channels[i].fn(channels[i].n, channels[i].b, ctx)
    },
    channelCount: channels.length,
  }
}
