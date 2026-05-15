/**
 * usePageTransition
 * ─────────────────
 * Barba.js-inspired transition system for React Router.
 *
 * Why not plain Barba.js?
 * Barba.js clones and swaps `data-barba="container"` DOM nodes, which
 * breaks React's reconciliation. Instead we mirror Barba's API
 * (namespaces + leave/enter hooks + a TRANSITIONS map) and drive the
 * animations ourselves via GSAP on a fixed overlay div.
 *
 * Usage:
 *   const go = usePageTransition()
 *   go('/login')              // async, no await needed in onClick
 *
 * Transition namespaces:
 *   /          →  'home'
 *   /login     →  'login'
 *   /signup    →  'signup'
 */

import { useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import gsap from 'gsap'

// ── Namespace resolution (mirrors Barba's data-barba-namespace) ───
const getNS = (path) => {
  if (path === '/' || path === '') return 'home'
  if (path.includes('/login'))     return 'login'
  if (path.includes('/signup'))    return 'signup'
  return 'other'
}

// Wait for exactly `n` animation frames (guarantees React has rendered)
const frames = (n = 2) => new Promise((resolve) => {
  let count = 0
  const tick = () => (++count >= n ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
})

// ── Transition map (mirrors Barba's transitions array) ────────────
//
//  Each entry has:
//    leave(overlay) → Promise  — animates the overlay IN (covers the screen)
//    enter(overlay) → Promise  — animates the overlay OUT (reveals new page)
//    stamp          — whether to flash the logo wordmark at peak
//
const TRANSITIONS = {

  // Home → Auth ─────────────────────────────────────────────────
  // Curtain rises from the bottom edge, then continues up off screen.
  // Metaphor: raising a theatre curtain — the new page is revealed from below.
  'home→auth': {
    stamp: true,
    async leave(el) {
      gsap.set(el, { yPercent: 100, xPercent: 0 })
      await gsap.to(el, { yPercent: 0, duration: 0.42, ease: 'power3.inOut' })
    },
    async enter(el) {
      await gsap.to(el, { yPercent: -100, duration: 0.42, ease: 'power3.inOut' })
    },
  },

  // Auth → Home ─────────────────────────────────────────────────
  // Curtain drops from the top edge, then continues down off screen.
  // Metaphor: lowering the curtain — we "go back up" in the hierarchy.
  'auth→home': {
    stamp: true,
    async leave(el) {
      gsap.set(el, { yPercent: -100, xPercent: 0 })
      await gsap.to(el, { yPercent: 0, duration: 0.42, ease: 'power3.inOut' })
    },
    async enter(el) {
      await gsap.to(el, { yPercent: 100, duration: 0.42, ease: 'power3.inOut' })
    },
  },

  // Login → Signup ──────────────────────────────────────────────
  // Wipe panel enters from the right, exits to the left.
  // Metaphor: advancing forward through a deck of cards.
  'login→signup': {
    stamp: false,
    async leave(el) {
      gsap.set(el, { xPercent: 100, yPercent: 0 })
      await gsap.to(el, { xPercent: 0, duration: 0.28, ease: 'power2.in' })
    },
    async enter(el) {
      // Brief pause lets the new form's entrance animation start
      await new Promise((r) => setTimeout(r, 80))
      await gsap.to(el, { xPercent: -100, duration: 0.28, ease: 'power2.out' })
    },
  },

  // Signup → Login ──────────────────────────────────────────────
  // Wipe panel enters from the left, exits to the right.
  // Metaphor: going back one card.
  'signup→login': {
    stamp: false,
    async leave(el) {
      gsap.set(el, { xPercent: -100, yPercent: 0 })
      await gsap.to(el, { xPercent: 0, duration: 0.28, ease: 'power2.in' })
    },
    async enter(el) {
      await new Promise((r) => setTimeout(r, 80))
      await gsap.to(el, { xPercent: 100, duration: 0.28, ease: 'power2.out' })
    },
  },
}

function resolveTransition(fromNS, toNS) {
  const exact = `${fromNS}→${toNS}`
  if (TRANSITIONS[exact]) return TRANSITIONS[exact]

  // Group aliases — any auth page is treated as the same namespace group
  const fromIsAuth = fromNS === 'login' || fromNS === 'signup'
  const toIsAuth   = toNS   === 'login' || toNS   === 'signup'

  if (fromNS === 'home' && toIsAuth)   return TRANSITIONS['home→auth']
  if (fromIsAuth && toNS === 'home')   return TRANSITIONS['auth→home']

  return null
}

// ── The hook ──────────────────────────────────────────────────────
export function usePageTransition() {
  const navigate = useNavigate()
  const location = useLocation()

  const go = useCallback(async (to) => {
    const fromNS = getNS(location.pathname)
    const toNS   = getNS(to)

    // Skip if already on the same namespace
    if (fromNS === toNS) return

    const transition = resolveTransition(fromNS, toNS)
    const overlay    = document.getElementById('page-transition-overlay')
    const stamp      = document.getElementById('pt-stamp')

    // Fallback to instant navigation if overlay isn't mounted
    if (!overlay || !transition) {
      navigate(to)
      return
    }

    // ── Make overlay interactive & visible ───────────────────
    gsap.set(overlay, { display: 'flex', pointerEvents: 'all' })
    if (stamp) gsap.set(stamp, { opacity: 0, scale: 0.88 })

    // ── LEAVE — cover the screen ─────────────────────────────
    await transition.leave(overlay)

    // ── Stamp: logo wordmark pulses at the peak ──────────────
    if (transition.stamp && stamp) {
      await gsap.to(stamp, {
        opacity: 1, scale: 1,
        duration: 0.14, ease: 'power2.out',
      })
      await new Promise((r) => setTimeout(r, 72)) // hold at peak
    }

    // ── SWAP — React Router navigates ────────────────────────
    navigate(to)
    await frames(2)                              // let React render the new page
    await new Promise((r) => setTimeout(r, 28)) // layout settle

    // ── Stamp fades out as enter begins ──────────────────────
    if (transition.stamp && stamp) {
      gsap.to(stamp, { opacity: 0, duration: 0.10 })
      await new Promise((r) => setTimeout(r, 55))
    }

    // ── ENTER — uncover the new page ─────────────────────────
    await transition.enter(overlay)

    // ── Reset overlay ─────────────────────────────────────────
    gsap.set(overlay, {
      display: 'none',
      pointerEvents: 'none',
      xPercent: 0,
      yPercent: 0,
    })
  }, [navigate, location.pathname])

  return go
}
