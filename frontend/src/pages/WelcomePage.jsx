import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import gsap from 'gsap'
import { usePageTransition } from '../transitions/usePageTransition'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { animate, scrambleText } from 'animejs'
import CyclingText from '../components/ui/CyclingText'
import CinematicScene from '../components/ui/CinematicScene'
import PixelSnow from '../components/ui/PixelSnow'

gsap.registerPlugin(ScrollTrigger)

// ─── Data ────────────────────────────────────────────────────
const TICKER_ITEMS = [
  'Customer Support Agent', 'Code Reviewer', 'Data Analyst',
  'Market Researcher', 'Content Creator', 'Sales Automator',
  'Financial Modeler', 'Workflow Automator', 'Lead Scorer',
]

const USE_CASES = [
  { icon: 'headset_mic', label: 'Customer Support', desc: '24/7 context-aware responses that resolve tickets, not deflect them.' },
  { icon: 'code', label: 'Code Review', desc: 'Analyse, debug, and optimise across the entire codebase autonomously.' },
  { icon: 'analytics', label: 'Data Analysis', desc: 'Surface insight from complex, noisy datasets in real time.' },
  { icon: 'science', label: 'Research', desc: 'Synthesise knowledge across thousands of sources into clear signals.' },
  { icon: 'edit_note', label: 'Content Creation', desc: 'Draft, refine, and publish on-brand content for any channel.' },
  { icon: 'trending_up', label: 'Sales Automation', desc: 'Qualify leads, draft personalised outreach, and close pipeline faster.' },
]

const REACT_STEPS = [
  { n: '01', label: 'REASON', desc: 'The agent analyses the task and builds a structured plan of action.' },
  { n: '02', label: 'ACT', desc: 'It executes — calling tools, querying APIs, writing and running code.' },
  { n: '03', label: 'OBSERVE', desc: 'Results loop back until the objective is completely solved.' },
]

// ─── Marquee ──────────────────────────────────────────────────
function Ticker() {
  const duped = [...TICKER_ITEMS, ...TICKER_ITEMS]
  return (
    <div className="overflow-hidden border-y border-white/[0.04]">
      <div className="animate-marquee flex w-max items-center py-3">
        {duped.map((item, i) => (
          <span key={i} className="flex items-center">
            <span className="px-8 font-headline text-[9px] font-bold uppercase tracking-[0.28em] text-white/[0.5]">
              {item}
            </span>
            <span className="text-white/[0.07]">·</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Logo ─────────────────────────────────────────────────────
function Wordmark({ size = 'md' }) {
  const sm = size === 'sm'
  return (
    <div className="flex items-center gap-2.5">
      <div className={`flex items-center justify-center bg-white ${sm ? 'h-7 w-7 rounded-lg' : 'h-8 w-8 rounded-xl'} shadow-[0_0_16px_rgba(255,255,255,0.10)]`}>
        <span className={`material-symbols-outlined text-black ${sm ? 'text-[14px]' : 'text-[16px]'}`}>hive</span>
      </div>
      <span className={`font-headline font-extrabold tracking-tight text-white ${sm ? 'text-base' : 'text-lg'}`}>
        Agent<span className="font-light italic text-white/100">Flow</span>
      </span>
    </div>
  )
}

// ─── Use-case card ────────────────────────────────────────────
function UseCaseCard({ icon, label, desc, delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-48px' }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -4, transition: { duration: 0.22 } }}
      className="group relative overflow-hidden rounded-3xl border border-white/[0.055] bg-white/[0.016] p-7
                 transition-colors duration-300 hover:border-white/[0.1] hover:bg-white/[0.028]"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent
                      opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
      <span className="material-symbols-outlined mb-5 block text-[18px] text-white/22
                       transition-colors duration-300 group-hover:text-white/48">
        {icon}
      </span>
      <h3 className="mb-2 font-headline text-[10px] font-bold uppercase tracking-[0.2em] text-white/65">{label}</h3>
      <p className="text-[11.5px] font-light leading-relaxed text-white/25">{desc}</p>
    </motion.div>
  )
}

// ─── Page ─────────────────────────────────────────────────────
export default function WelcomePage() {
  const go = usePageTransition()

  const navRef = useRef(null)
  const anRef = useRef(null)
  const agentRef = useRef(null)
  const canBeRef = useRef(null)
  const cycleRef = useRef(null)
  const taglineRef = useRef(null)
  const mobileRef = useRef(null)
  const reactRef = useRef(null)
  const ctaRef = useRef(null)

  useEffect(() => {
    // ── Lenis ────────────────────────────────────────────────
    const lenis = new Lenis({
      duration: 1.4,
      easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    })
    lenis.on('scroll', ScrollTrigger.update)
    const lenisRaf = time => lenis.raf(time * 1000)
    gsap.ticker.add(lenisRaf)
    gsap.ticker.lagSmoothing(0)

    // ── Initial state — text below clip, others invisible ────
    gsap.set([anRef.current, agentRef.current, canBeRef.current], { y: '110%' })
    gsap.set([navRef.current, cycleRef.current, taglineRef.current,
    mobileRef.current], { opacity: 0, y: 20 })

    // ── Entrance timeline ────────────────────────────────────
    const tl = gsap.timeline({ defaults: { ease: 'power4.out' } })

    tl.to(navRef.current, { opacity: 1, y: 0, duration: 0.55 }, 0.05)
      .to(anRef.current, { y: '0%', duration: 0.9 }, 0.2)
      .to(agentRef.current, { y: '0%', duration: 0.95 }, 0.32)
      .to(canBeRef.current, { y: '0%', duration: 0.85 }, 0.48)
      .to(cycleRef.current, { opacity: 1, y: 0, duration: 0.7 }, 0.62)
      .to(taglineRef.current, { opacity: 1, y: 0, duration: 0.65 }, 0.68)
      .to(mobileRef.current, { opacity: 1, y: 0, duration: 0.6 }, 0.74)

    // AnimeJS scramble on "AN" as it reveals
    tl.call(() => {
      if (anRef.current) {
        animate(anRef.current, {
          innerHTML: scrambleText({ chars: 'uppercase', speed: 0.45 }),
          duration: 750,
          ease: 'linear',
        })
      }
    }, [], 0.65)

    // ── ScrollTrigger: ReAct steps ───────────────────────────
    if (reactRef.current) {
      gsap.fromTo(
        reactRef.current.querySelectorAll('.step-item'),
        { y: 48, opacity: 0 },
        {
          y: 0, opacity: 1, duration: 0.7, stagger: 0.14, ease: 'power3.out',
          scrollTrigger: { trigger: reactRef.current, start: 'top 72%', once: true }
        },
      )
    }

    // ── ScrollTrigger: CTA section ───────────────────────────
    if (ctaRef.current) {
      gsap.fromTo(
        ctaRef.current.querySelectorAll('.cta-item'),
        { y: 36, opacity: 0 },
        {
          y: 0, opacity: 1, duration: 0.68, stagger: 0.1, ease: 'power3.out',
          scrollTrigger: { trigger: ctaRef.current, start: 'top 75%', once: true }
        },
      )
    }

    return () => {
      tl.kill()
      gsap.ticker.remove(lenisRaf)
      lenis.destroy()
      ScrollTrigger.getAll().forEach(t => t.kill())
    }
  }, [])

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-black font-body text-white selection:bg-white/20">

      {/* ── Fixed PixelSnow backdrop ──────────────────────── */}
      <div className="pointer-events-none fixed inset-0 z-0s">
        <PixelSnow
          color="#b8b8b8"
          flakeSize={0.013}
          minFlakeSize={1.0}
          pixelResolution={195}
          speed={0.52}
          depthFade={7}
          brightness={1.25}
          density={0.38}
          variant="snowflake"
        />
        <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-black to-transparent" />
      </div>

      {/* ══════════════════════════════════════════════════════
          HERO
      ══════════════════════════════════════════════════════ */}
      <section className="relative z-10 flex min-h-[100dvh] flex-col">

        {/* Nav */}
        <nav ref={navRef} className="flex items-center justify-between px-6 py-5 opacity-0 sm:px-10 lg:px-14">
          <Wordmark />
          <div className="flex items-center gap-1.5">
            <motion.button
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
              onClick={() => go('/login')}
              className="rounded-full border border-white/[0.07] px-5 py-2.5 font-headline text-[10px]
                         font-bold uppercase tracking-[0.16em] text-white/36
                         transition-all hover:border-white/14 hover:text-white/65"
            >
              Login
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
              onClick={() => go('/signup')}
              className="rounded-full bg-white px-5 py-2.5 font-headline text-[10px] font-bold
                         uppercase tracking-[0.16em] text-black shadow-[0_0_20px_rgba(255,255,255,0.11)]
                         transition-all hover:shadow-[0_0_36px_rgba(255,255,255,0.26)]"
            >
              Sign Up
            </motion.button>
          </div>
        </nav>

        {/* ── Hero content ──────────────────────────────────── */}
        <div className="relative flex flex-1 items-start px-6 pb-36 pt-8 sm:px-10 lg:items-center lg:px-14 lg:pb-20 lg:pt-0">

          {/* ── Cinematic 3D model — right half, desktop only ── */}
          <div className="absolute bottom-0 right-0 top-0 hidden w-[60%] lg:block">
            <CinematicScene />
          </div>

          {/*
            Readability gradient — semi-transparent so PixelSnow
            shows through everywhere; left side is dimmed enough
            for text contrast, right side is clear for the model.
          */}
          <div
            className="pointer-events-none absolute inset-0 hidden lg:block"
            style={{
              background: 'linear-gradient(to right, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.48) 32%, rgba(0,0,0,0.14) 58%, transparent 76%)',
            }}
          />

          {/* Typography — left column */}
          <div className="relative z-10 w-full min-w-0 lg:w-[45%]">

            {/* ─ Eyebrow pill ─────────────────────────────── */}
            <div className="mb-8 inline-flex items-center gap-2.5 rounded-full border border-white/[0.07]
                            bg-white/[0.025] px-4 py-2 backdrop-blur-sm">
              <span className="relative flex h-[5px] w-[5px]">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/50 opacity-75" />
                <span className="relative inline-flex h-[5px] w-[5px] rounded-full bg-white/55" />
              </span>
              <span className="font-headline text-[8.5px] font-bold uppercase tracking-[0.3em] text-white/32">
                Multi-agent platform
              </span>
              <span className="ml-1 font-headline text-[8px] font-bold uppercase tracking-[0.2em] text-white/15">
                v1.0
              </span>
            </div>

            {/* ─ Display headline ─────────────────────────── */}
            {/*
              Three-line weight cascade:
                1. "AN"    — black weight, solid white
                2. "AGENT" — black weight, outline/ghost (webkit-text-stroke)
                3. "CAN BE"— light weight, 7% white (near-invisible depth)
              All three use clip-reveal (overflow:hidden + translateY) for the entrance.
            */}

            {/* Line 1: AN — solid black weight */}
            <div className="overflow-hidden" style={{ lineHeight: 0.88 }}>
              <h1
                ref={anRef}
                className="font-headline font-black uppercase tracking-[-0.03em] text-white
                           text-[11vw] sm:text-[8.5vw] lg:text-[6vw]"
              >
                AN
              </h1>
            </div>

            {/* Line 2: AGENT — outline / ghost */}
            <div className="overflow-hidden" style={{ lineHeight: 0.88 }}>
              <h1
                ref={agentRef}
                className="font-headline font-black uppercase tracking-[-0.03em] text-white
                           text-[11vw] sm:text-[8.5vw] lg:text-[6vw]"
                style={{
                  WebkitTextStroke: '1.2px rgba(255,255,255,0.46)',
                  color: 'transparent',
                }}
              >
                AGENT
              </h1>
            </div>

            {/* Line 3: CAN BE — near-invisible whisper */}
            <div className="overflow-hidden" style={{ lineHeight: 0.88 }}>
              <h1
                ref={canBeRef}
                className="font-headline font-light uppercase tracking-[-0.02em] text-white/[0.28]
                           text-[11vw] sm:text-[8.5vw] lg:text-[6vw]"
              >
                CAN BE
              </h1>
            </div>

            {/* ─ Cycling use-case (display-scale italic) ──── */}
            <div ref={cycleRef} className="mt-4 opacity-0">
              <CyclingText />
            </div>

            {/* ─ Tagline + desktop CTAs ────────────────────── */}
            <div ref={taglineRef} className="mt-12 opacity-0">
              {/* Thin ruled divider */}
              <div className="mb-6 flex items-center gap-4">
                <div className="h-px w-8 bg-white/[0.08]" />
                <span className="font-headline text-[8.5px] font-bold uppercase tracking-[0.28em] text-white/20">
                  Build anything
                </span>
              </div>
              <p className="mb-8 max-w-[30ch] text-[12.5px] font-light leading-[1.85] text-white/28">
                Spin up ReAct agents for any workflow, any use case — no orchestration overhead.
              </p>
              <div className="hidden items-center gap-4 lg:flex">
                <motion.button
                  whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
                  onClick={() => go('/signup')}
                  className="group/btn flex items-center gap-2.5 rounded-full bg-white px-8 py-4
                             font-headline text-[11px] font-bold uppercase tracking-[0.1em] text-black
                             shadow-[0_0_36px_rgba(255,255,255,0.14)] transition-all
                             hover:shadow-[0_0_54px_rgba(255,255,255,0.30)]"
                >
                  Start Building
                  <span className="material-symbols-outlined text-[14px] transition-transform duration-300 group-hover/btn:translate-x-1">
                    arrow_forward
                  </span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => go('/login')}
                  className="rounded-full border border-white/[0.08] px-8 py-4 font-headline text-[11px]
                             font-bold uppercase tracking-[0.1em] text-white/34 transition-all
                             hover:border-white/16 hover:text-white/65"
                >
                  Sign In
                </motion.button>
              </div>
            </div>
          </div>

        </div>

        {/* Mobile CTAs */}
        <div ref={mobileRef}
          className="absolute bottom-8 left-0 right-0 flex flex-col gap-2 px-6 opacity-0 sm:px-10 lg:hidden"
        >
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={() => go('/signup')}
            className="group/btn flex w-full items-center justify-between rounded-full bg-white px-7 py-4
                       font-headline text-[11px] font-bold uppercase tracking-[0.1em] text-black
                       shadow-[0_0_30px_rgba(255,255,255,0.11)]"
          >
            <span>Start Building</span>
            <span className="material-symbols-outlined text-[14px] transition-transform duration-300 group-hover/btn:translate-x-1">
              arrow_forward
            </span>
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={() => go('/login')}
            className="flex w-full items-center justify-center rounded-full border border-white/[0.07]
                       bg-white/[0.02] px-7 py-4 font-headline text-[11px] font-bold
                       uppercase tracking-[0.1em] text-white/36 backdrop-blur-sm"
          >
            Sign In
          </motion.button>
        </div>

        {/* Marquee ticker */}
        <div className="relative z-10 mt-auto">
          <Ticker />
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION — REACT LOOP
      ══════════════════════════════════════════════════════ */}
      <section ref={reactRef} className="relative z-10 bg-black px-6 py-28 sm:px-10 lg:px-14 lg:py-40">
        <div className="mx-auto max-w-5xl">

          <div className="mb-10 flex items-center gap-4">
            <div className="h-px w-6 bg-white/[0.08]" />
            <span className="font-headline text-[8.5px] font-bold uppercase tracking-[0.3em] text-white/40">
              How it thinks
            </span>
          </div>

          {/* Section headline — same weight cascade as hero */}
          <div className="mb-20 space-y-0">
            <div className="overflow-hidden" style={{ lineHeight: 0.88 }}>
              <h2 className="font-headline font-black uppercase tracking-tight text-white
                             text-[9vw] sm:text-[7vw] lg:text-[5vw]">
                Reason.
              </h2>
            </div>
            <div className="overflow-hidden" style={{ lineHeight: 0.88 }}>
              <h2 className="font-headline font-black uppercase tracking-tight
                             text-[9vw] sm:text-[7vw] lg:text-[5vw]"
                style={{ WebkitTextStroke: '1px rgba(255,255,255,0.5)', color: 'transparent' }}>
                Act.
              </h2>
            </div>
            <div className="overflow-hidden" style={{ lineHeight: 0.88 }}>
              <h2 className="font-headline font-light uppercase tracking-tight text-white/[0.65]
                             text-[9vw] sm:text-[7vw] lg:text-[5vw]">
                Observe.
              </h2>
            </div>
          </div>

          <div className="grid overflow-hidden rounded-3xl border border-white/[0.05] sm:grid-cols-3">
            {REACT_STEPS.map(({ n, label, desc }) => (
              <div key={label}
                className="step-item group relative bg-black p-8 opacity-0 transition-colors duration-300 hover:bg-white/[0.016]
                           border-b border-white/[0.05] last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 sm:border-white/[0.05]"
              >
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.09] to-transparent
                               opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
                <span className="mb-7 block font-headline text-[8.5px] font-bold tracking-[0.3em] text-white/14">{n}</span>
                <h3 className="mb-3 font-headline text-base font-bold uppercase tracking-widest text-white">{label}</h3>
                <p className="text-[11px] font-light leading-relaxed text-white/45">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION — USE CASES
      ══════════════════════════════════════════════════════ */}
      <section className="relative z-10 bg-black px-6 py-20 sm:px-10 lg:px-14 lg:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="mb-10 flex items-center gap-4">
            <div className="h-px w-6 bg-white/[0.08]" />
            <span className="font-headline text-[8.5px] font-bold uppercase tracking-[0.3em] text-white/20">
              Use cases
            </span>
          </div>
          <h2 className="mb-14 font-headline uppercase tracking-tight text-white
                         text-[8vw] sm:text-[5.5vw] lg:text-[3.8vw]">
            <span className="font-bold">Built for</span><br />
            <span className="font-light text-white/16">any workflow.</span>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map(({ icon, label, desc }, i) => (
              <UseCaseCard key={label} icon={icon} label={label} desc={desc} delay={i * 0.05} />
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION — FINAL CTA
      ══════════════════════════════════════════════════════ */}
      <section ref={ctaRef} className="relative z-10 overflow-hidden bg-black px-6 py-32 sm:px-10 lg:px-14 lg:py-52">
        <div className="mx-auto max-w-4xl">
          <div className="cta-item mb-14 h-px w-full bg-white/[0.035] opacity-0" />
          <p className="cta-item mb-4 font-headline text-[8.5px] font-bold uppercase tracking-[0.3em] text-white/15 opacity-0">
            Get started today
          </p>
          <h2 className="cta-item mb-10 font-headline uppercase leading-none tracking-tight opacity-0
                         text-[13vw] sm:text-[10vw] lg:text-[7.5vw]">
            <span className="font-black text-white">BUILD</span><br />
            <span className="font-light text-white/10">ANYTHING.</span>
          </h2>
          <p className="cta-item mb-12 max-w-[26ch] text-[12.5px] font-light leading-[1.85] text-white/26 opacity-0">
            Your first ReAct agent is one click away.<br />No infrastructure. No boilerplate.
          </p>
          <div className="cta-item flex flex-wrap items-center gap-5 opacity-0">
            <motion.button
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
              onClick={() => go('/signup')}
              className="group/btn flex items-center gap-3 rounded-full bg-white px-10 py-5 font-headline
                         text-[12px] font-bold uppercase tracking-[0.1em] text-black
                         shadow-[0_0_44px_rgba(255,255,255,0.15)] transition-all
                         hover:shadow-[0_0_72px_rgba(255,255,255,0.34)]"
            >
              Create Account
              <span className="material-symbols-outlined text-[15px] transition-transform duration-300 group-hover/btn:translate-x-1.5">
                arrow_forward
              </span>
            </motion.button>
            <button
              onClick={() => go('/login')}
              className="font-headline text-[11px] font-bold uppercase tracking-[0.1em] text-white/22
                         underline decoration-white/[0.08] underline-offset-4
                         transition-colors hover:text-white/48 hover:decoration-white/25"
            >
              Already have an account
            </button>
          </div>
        </div>

        {/* Ghost watermark */}
        <div className="pointer-events-none absolute -bottom-8 -right-4 select-none opacity-[0.018]">
          <span className="font-headline font-black uppercase leading-none tracking-tighter text-white"
            style={{ fontSize: '24vw' }}>
            AF
          </span>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 flex items-center justify-between border-t border-white/[0.035]
                         bg-black px-6 py-5 sm:px-10 lg:px-14">
        <Wordmark size="sm" />
        <p className="font-headline text-[8.5px] font-bold uppercase tracking-[0.22em] text-white/12">
          © {new Date().getFullYear()} AgentFlow
        </p>
      </footer>
    </div>
  )
}
