import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'

/* ─── Animation Variants ────────────────────────────────── */
const reveal = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
}
const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] } },
}

/* ─── Frameless Telemetry Stat ──────────────────────────── */
function TelemetryStat({ label, value, live }) {
  return (
    <div className="flex flex-col relative shrink-0 min-w-[120px]">
      <div className="flex items-start gap-3">
        <span className="font-headline text-[3.5rem] font-bold leading-[0.85] tracking-tighter text-white">
          {value}
        </span>
        {live && (
          <span className="relative flex h-2 w-2 mt-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]" />
          </span>
        )}
      </div>
      <span className="mt-4 font-headline text-[10px] font-bold uppercase tracking-[0.25em] text-white/30">
        {label}
      </span>
    </div>
  )
}

/* ─── Model Row ─────────────────────────────────────────── */
function ModelRow({ model }) {
  const providerMeta = {
    openai: { icon: 'bubble_chart', label: 'OpenAI' },
    anthropic: { icon: 'psychiatry', label: 'Anthropic' },
    nvidia: { icon: 'memory', label: 'NVIDIA' },
  }
  const meta = providerMeta[model.provider] ?? { icon: 'blur_on', label: model.provider }

  return (
    <div className="group flex items-center justify-between gap-4 py-3.5 border-b border-white/[0.04] last:border-0 transition-colors hover:bg-white/[0.02] -mx-4 px-4 cursor-default">

      {/* Name + ID */}
      <div className="min-w-0">
        <p className="font-headline text-[13px] font-semibold tracking-wide text-white/80 truncate transition-colors group-hover:text-white">
          {model.name}
        </p>
        <p className="font-mono text-[9px] text-white/25 truncate tracking-tight mt-0.5">{model.api_model_id}</p>
      </div>

      {/* Provider attribution pill */}
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-white/40 transition-opacity opacity-70 group-hover:opacity-100 group-hover:text-white/60">
        <span className="font-headline text-[9px] font-bold uppercase tracking-[0.12em]">{meta.label}</span>
      </div>

    </div>
  )
}


/* ─── Sub-Panel: LLMs ───────────────────────────────────── */
function LLMsPanel({ models, loading }) {
  const [expanded, setExpanded] = useState(false)
  const COLLAPSED_COUNT = 5
  const hasMore = models.length > COLLAPSED_COUNT

  return (
    <motion.div variants={fadeUp}>
      <motion.div
        layout
        className="rounded-3xl border border-white/[0.06] bg-[#0A0A0A]/80 backdrop-blur-3xl overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >

        {/* ── Header inside panel ── */}
        <motion.div layout="position" className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-white/[0.04]">
          <h2 className="font-headline text-[11px] font-bold uppercase tracking-[0.25em] text-white/50">
            LLMs
          </h2>
          {!loading && models.length > 0 && (
            <span className="font-headline text-[9px] font-bold uppercase tracking-[0.2em] text-white/20">
              {models.length} available
            </span>
          )}
        </motion.div>

        {/* ── List body ── */}
        <div className="px-6 pb-2 pt-2">
          {loading ? (
            <div className="flex justify-center py-10">
              <motion.span
                className="material-symbols-outlined text-white/20 text-2xl"
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
              >
                autorenew
              </motion.span>
            </div>
          ) : models.length === 0 ? (
            <p className="py-10 text-center font-headline text-[10px] font-bold uppercase tracking-[0.2em] text-white/20">
              No LLMs Detected
            </p>
          ) : (
            <>
              {/* Always-visible first set */}
              <div>
                {models.slice(0, COLLAPSED_COUNT).map(m => (
                  <ModelRow key={m.model_id} model={m} />
                ))}
              </div>

              {/* Smooth expand for remaining rows */}
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    key="extra-rows"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                    style={{ overflow: 'hidden' }}
                  >
                    {models.slice(COLLAPSED_COUNT).map(m => (
                      <ModelRow key={m.model_id} model={m} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>

        {/* ── Expand toggle ── */}
        {hasMore && !loading && (
          <motion.div layout="position" className="border-t border-white/[0.04] mx-0">
            <button
              onClick={() => setExpanded(prev => !prev)}
              className="w-full flex items-center justify-center gap-2 py-4 font-headline text-[9px] font-bold uppercase tracking-[0.22em] text-white/30 transition-colors hover:text-white hover:bg-white/[0.03]"
            >
              {expanded ? 'Show less' : `${models.length - COLLAPSED_COUNT} more`}
              <motion.span
                className="material-symbols-outlined text-[15px]"
                animate={{ rotate: expanded ? 180 : 0 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              >
                keyboard_arrow_down
              </motion.span>
            </button>
          </motion.div>
        )}

      </motion.div>
    </motion.div>
  )
}

/* ─── Dashboard ─────────────────────────────────────────── */
export default function DashboardPage() {
  const { token } = useAuth()
  const [models, setModels] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    fetch('http://localhost:9090/api/llms', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then(data => setModels(data ?? []))
      .catch(() => { })
      .finally(() => setLoading(false))
  }, [token])

  return (
    <motion.section
      variants={reveal}
      initial="hidden"
      animate="show"
      className="w-full max-w-[1600px] pb-32"
    >
      {/* ── Page Header ── */}
      <motion.div variants={fadeUp} className="mb-16 flex items-center justify-between">
        <div>
          <h1 className="font-headline text-5xl font-bold uppercase tracking-tight text-white mb-2">
            Workspace
          </h1>
          <p className="font-headline text-[11px] font-bold uppercase tracking-[0.3em] text-white/20">
            System Overview & Operations
          </p>
        </div>
        <button className="hidden sm:flex group h-14 w-14 items-center justify-center rounded-full bg-white text-black transition-all hover:scale-105 hover:bg-neutral-200">
          <span className="material-symbols-outlined text-[24px]">add</span>
        </button>
      </motion.div>

      {/* ── Main Asymmetric Layout ── */}
      <div className="flex flex-col xl:flex-row gap-16 lg:gap-24">

        {/* Left Column: Telemetry & primary operations (flex-1) */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Frameless Telemetry Strip */}
          <motion.div variants={fadeUp} className="flex flex-wrap items-center justify-between gap-x-16 gap-y-12 pb-14 mb-14 border-b border-white/[0.06]">
            <TelemetryStat label="Agents" value="0" />
            <TelemetryStat label="LLMs" value={loading ? '—' : models.length} />
            <TelemetryStat label="Tools" value="0" />
            <TelemetryStat label="Jobs" value="0" />
          </motion.div>

          {/* Jobs Terminal / Main Feed */}
          <motion.div variants={fadeUp} className="flex flex-col flex-1">
            <h2 className="font-headline text-[11px] font-bold uppercase tracking-[0.25em] text-white/50 mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">terminal</span>
              Active Jobs
            </h2>

            <div className="relative flex flex-col flex-1 min-h-[400px] rounded-3xl border border-white/[0.06] bg-black/40 overflow-hidden group">
              {/* Subtle grid background texture */}
              <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] opacity-20 pointer-events-none mix-blend-screen" />

              <div className="relative z-10 flex flex-col items-center justify-center h-full gap-5">
                <div className="h-16 w-16 border border-white/10 rounded-full flex items-center justify-center bg-white/[0.02] shadow-[0_0_32px_rgba(255,255,255,0.02)]">
                  <span className="material-symbols-outlined text-[28px] text-white/20">memory_alt</span>
                </div>
                <div className="text-center">
                  <p className="font-headline text-[15px] font-semibold text-white/70 tracking-wide">No active jobs detected</p>
                </div>
                <button className="border border-white/20 rounded-full px-6 py-2.5 font-headline text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:bg-white hover:text-black">
                  Deploy Job
                </button>
              </div>
            </div>
          </motion.div>

        </div>

        {/* Right Node: Infrastructure Side-panel */}
        <div className="w-full xl:w-[420px] shrink-0 flex flex-col gap-12">

          {/* LLMs Panel */}
          <LLMsPanel models={models} loading={loading} />

          {/* Tools Panel */}
          <motion.div variants={fadeUp} className="flex flex-col">
            <div className="flex items-baseline justify-between mb-6">
              <h2 className="font-headline text-[11px] font-bold uppercase tracking-[0.25em] text-white/50 flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]">extension</span>
                Integrations
              </h2>
              <button className="group flex items-center gap-1 font-headline text-[9px] font-bold uppercase tracking-[0.2em] text-white/30 hover:text-white transition-colors">
                Add
                <span className="material-symbols-outlined text-[12px] transition-transform group-hover:translate-x-0.5">arrow_forward</span>
              </button>
            </div>

            <div className="rounded-3xl border border-white/[0.06] bg-[#0A0A0A]/80 backdrop-blur-3xl overflow-hidden p-8 shadow-[0_8px_32px_rgba(0,0,0,0.4)] flex flex-col items-center justify-center min-h-[200px]">
              <span className="material-symbols-outlined text-white/10 text-4xl mb-3">api</span>
              <p className="font-headline text-[10px] font-bold uppercase tracking-[0.2em] text-white/30 text-center">
                No APIs linked
              </p>
            </div>
          </motion.div>

        </div>
      </div>
    </motion.section>
  )
}
