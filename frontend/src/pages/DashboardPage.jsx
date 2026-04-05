import { motion } from 'framer-motion'

const containerReveal = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
}

const itemReveal = {
  hidden: { opacity: 0, y: 30 },
  show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] } },
}

function StatCard({ title, value, detail, status }) {
  return (
    <motion.div
      variants={itemReveal}
      className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] p-8 backdrop-blur-2xl transition-colors hover:bg-white/[0.04]"
    >
      <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-white/5 blur-3xl transition-opacity group-hover:opacity-100 opacity-50" />

      <p className="font-headline text-[11px] font-bold uppercase tracking-[0.2em] text-white/40 mb-8">
        {title}
      </p>

      <div className="flex items-end gap-4">
        <h3 className="font-headline text-5xl font-extrabold tracking-tight text-white drop-shadow-[0_0_16px_rgba(255,255,255,0.1)]">
          {value}
        </h3>
        {status === 'active' && (
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75"></span>
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,1)]"></span>
            </span>
            <span className="font-headline text-[10px] font-bold uppercase tracking-[0.1em] text-white">Live</span>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs font-light text-white/50">{detail}</p>
    </motion.div>
  )
}

function QuickActionCard({ title, icon, colorClass }) {
  return (
    <motion.button
      variants={itemReveal}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className="flex w-full items-center justify-between overflow-hidden rounded-2xl border border-white/10 bg-white/[0.01] p-6 backdrop-blur-md transition-colors hover:bg-white/[0.05]"
    >
      <div className="flex items-center gap-4">
        <div className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white shadow-[0_0_16px_rgba(255,255,255,0.05)]`}>
          <span className="material-symbols-outlined">{icon}</span>
        </div>
        <span className="font-headline text-[13px] font-bold uppercase tracking-[0.1em] text-white">
          {title}
        </span>
      </div>
      <span className="material-symbols-outlined text-white/30 transition-transform group-hover:translate-x-1">
        east
      </span>
    </motion.button>
  )
}

function DashboardPage() {
  return (
    <motion.section
      variants={containerReveal}
      initial="hidden"
      animate="show"
      className="min-h-full max-w-7xl"
    >
      {/* Header */}
      <motion.div variants={itemReveal} className="mb-14 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-1 mb-4 font-headline text-[10px] font-bold uppercase tracking-[0.2em] text-white/70">
            Overview
          </span>
          <h1 className="font-headline text-5xl font-extrabold tracking-tight text-white sm:text-6xl text-balance">
            Dashboard
          </h1>
        </div>
        <button className="flex items-center gap-3 rounded-full bg-white px-6 py-3.5 shadow-[0_0_24px_rgba(255,255,255,0.15)] transition-all hover:bg-neutral-200 hover:shadow-[0_0_36px_rgba(255,255,255,0.3)]">
          <span className="material-symbols-outlined text-[18px] text-black">add</span>
          <span className="font-headline text-[11px] font-bold uppercase tracking-[0.15em] text-black">New Agent</span>
        </button>
      </motion.div>



    </motion.section>
  )
}

export default DashboardPage
