import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { animate, createTimeline, stagger } from 'animejs'
import PixelSnow from '../ui/PixelSnow'
import TransitionLink from '../../transitions/TransitionLink'

// Rotate through brand statements in the left panel
const BRAND_LINES = [
  'Every agent starts here.',
  'Intelligence, on demand.',
  'Your logic. Deployed.',
  'ReAct. At scale.',
]

function ToggleLink({ to, label, isActive }) {
  return (
    <TransitionLink
      to={to}
      className={`relative rounded-full px-6 py-2.5 font-headline text-[11px] font-bold uppercase tracking-[0.15em] transition-all duration-300 ${
        isActive
          ? 'bg-white text-black shadow-[0_2px_20px_rgba(255,255,255,0.2)]'
          : 'text-white/40 hover:text-white'
      }`}
    >
      {label}
    </TransitionLink>
  )
}

// Left panel decorative stat
function StatBadge({ value, label }) {
  return (
    <div className="flex flex-col">
      <span className="font-headline text-3xl font-bold text-white">{value}</span>
      <span className="mt-0.5 text-[11px] font-light uppercase tracking-[0.12em] text-white/30">{label}</span>
    </div>
  )
}

export default function AuthShell({
  mode,
  title,
  subtitle,
  submitLabel,
  switchLabel,
  switchCta,
  switchTo,
  onSubmit,
  children,
}) {
  const formRef      = useRef(null)
  const titleRef     = useRef(null)
  const brandLineRef = useRef(null)
  const lineIndex    = useRef(0)

  // ── Form entrance animation (AnimeJS timeline) ────────────
  useEffect(() => {
    if (!formRef.current) return

    const elements = formRef.current.querySelectorAll('.form-item')

    createTimeline({
      defaults: { ease: 'outExpo', duration: 600 },
    })
      .add(elements, { opacity: [0, 1], translateY: [20, 0], delay: stagger(80) }, 120)
  }, [mode])

  // ── Cycling brand line (AnimeJS) ──────────────────────────
  useEffect(() => {
    if (!brandLineRef.current) return

    const cycle = () => {
      animate(brandLineRef.current, {
        opacity: [1, 0],
        translateY: [0, -10],
        duration: 400,
        ease: 'inCubic',
        onComplete: () => {
          lineIndex.current = (lineIndex.current + 1) % BRAND_LINES.length
          if (brandLineRef.current) {
            brandLineRef.current.textContent = BRAND_LINES[lineIndex.current]
          }
          animate(brandLineRef.current, {
            opacity: [0, 1],
            translateY: [10, 0],
            duration: 500,
            ease: 'outExpo',
          })
        },
      })
    }

    const id = setInterval(cycle, 3200)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex h-screen w-full overflow-hidden bg-black font-body text-white selection:bg-white/20">

      {/* ── LEFT PANEL ──────────────────────────────────────── */}
      <div className="relative hidden w-[42%] flex-col overflow-hidden border-r border-white/[0.05] lg:flex">

        {/* Pixel snow backdrop */}
        <div className="absolute inset-0 z-0">
          <PixelSnow
            color="#ffffff"
            flakeSize={0.012}
            minFlakeSize={0.9}
            pixelResolution={180}
            speed={0.5}
            depthFade={7}
            brightness={1.0}
            density={0.35}
            variant="snowflake"
          />
          {/* Gradient overlays for depth */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-transparent to-black/90" />
          <div className="absolute inset-0 bg-gradient-to-r from-transparent to-black/60" />
        </div>

        {/* Content */}
        <div className="relative z-10 flex h-full flex-col justify-between p-10 xl:p-14">

          {/* Logo */}
          <TransitionLink to="/" className="inline-flex items-center gap-3 transition-opacity hover:opacity-70">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white shadow-[0_0_20px_rgba(255,255,255,0.15)]">
              <span className="material-symbols-outlined text-[18px] text-black">hive</span>
            </div>
            <span className="font-headline text-xl font-extrabold tracking-tight text-white">
              Agent<span className="font-light italic text-white/40">Flow</span>
            </span>
          </TransitionLink>

          {/* Center copy */}
          <div>
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className="font-headline text-[3.2rem] font-semibold uppercase leading-[1.0] tracking-tight text-white xl:text-[4rem]"
            >
              Build any<br />
              <span className="text-white/25 font-light">agent.</span>
            </motion.h2>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3, duration: 0.8 }}
              className="mt-6 max-w-xs text-[14px] font-light leading-relaxed text-white/35"
            >
              AgentFlow gives you the primitives to create ReAct agents for any use case — without the overhead.
            </motion.p>

            {/* Cycling brand line */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.8 }}
              className="mt-10 flex items-center gap-3"
            >
              <div className="h-px w-6 bg-white/20" />
              <p
                ref={brandLineRef}
                className="font-headline text-[11px] font-bold uppercase tracking-[0.18em] text-white/35"
              >
                {BRAND_LINES[0]}
              </p>
            </motion.div>
          </div>

          {/* Stats row */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.8 }}
            className="flex items-end gap-10"
          >
            <StatBadge value="∞" label="Use cases" />
            <StatBadge value="1" label="Platform" />
          </motion.div>
        </div>
      </div>

      {/* ── RIGHT PANEL ─────────────────────────────────────── */}
      <div className="relative flex w-full flex-col overflow-y-auto lg:w-[58%]">

        {/* Subtle noise/grain from WelcomePage — no tinted glow */}

        {/* Mobile logo */}
        <div className="relative z-10 flex items-center justify-between px-8 pt-8 lg:hidden">
          <TransitionLink to="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-black shadow-[0_0_20px_rgba(255,255,255,0.15)]">
              <span className="material-symbols-outlined text-[18px]">hive</span>
            </div>
            <span className="font-headline text-xl font-extrabold tracking-tight text-white">
              Agent<span className="font-light italic text-white/40">Flow</span>
            </span>
          </TransitionLink>
        </div>

        {/* Form area */}
        <div className="relative z-10 my-auto flex flex-col justify-center px-8 py-16 sm:px-14 xl:px-20">
          <div className="w-full max-w-[420px]">

            {/* Toggle pill */}
            <div className="mb-12">
              <div className="inline-flex rounded-full bg-white/[0.04] p-1.5 ring-1 ring-white/[0.08] backdrop-blur-md">
                <ToggleLink to="/login"  label="Log in"  isActive={mode === 'login'} />
                <ToggleLink to="/signup" label="Sign up" isActive={mode === 'signup'} />
              </div>
            </div>

            {/* Title */}
            <AnimatePresence mode="wait">
              <motion.div
                key={mode}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="mb-10"
              >
                <h1 ref={titleRef} className="font-headline text-5xl font-bold uppercase leading-none tracking-tight text-white sm:text-6xl">
                  {title}
                </h1>
                <div className="mt-5 h-px w-10 bg-white/15" />
                <p className="mt-4 text-[13px] font-light leading-relaxed text-white/35 max-w-xs">
                  {subtitle}
                </p>
              </motion.div>
            </AnimatePresence>

            {/* Form */}
            <form
              ref={formRef}
              className="space-y-5"
              onSubmit={onSubmit || ((e) => e.preventDefault())}
            >
              {children}

              {/* Submit */}
              <div className="form-item pt-2 opacity-0">
                <motion.button
                  type="submit"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="group/btn relative flex w-full items-center justify-between overflow-hidden rounded-full bg-white px-7 py-4 shadow-[0_0_32px_rgba(255,255,255,0.15)] transition-all hover:shadow-[0_0_48px_rgba(255,255,255,0.3)]"
                >
                  <span className="font-headline text-[12px] font-bold uppercase tracking-[0.12em] text-black">
                    {submitLabel}
                  </span>
                  <span className="material-symbols-outlined text-[18px] text-black transition-transform duration-300 group-hover/btn:translate-x-1">
                    arrow_forward
                  </span>
                </motion.button>
              </div>
            </form>

            {/* Switch link */}
            <p className="form-item mt-8 text-[12px] font-light text-white/35 opacity-0">
              {switchLabel}{' '}
              <TransitionLink
                to={switchTo}
                className="font-bold tracking-wide text-white underline decoration-white/20 underline-offset-4 transition-colors hover:decoration-white"
              >
                {switchCta}
              </TransitionLink>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
