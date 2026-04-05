import { useAtom, useAtomValue } from 'jotai'
import {
  globalSearchAtom,
  sidebarCollapsedAtom,
  sidebarOpenAtom,
} from '../../store/atoms/appAtoms'

function TopNav() {
  const [searchQuery, setSearchQuery] = useAtom(globalSearchAtom)
  const [, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)

  return (
    <header
      className={`fixed right-0 top-0 z-40 h-24 border-b border-white/5 bg-black/60 backdrop-blur-2xl transition-[left] duration-300 ${sidebarCollapsed ? 'lg:left-[88px]' : 'lg:left-72'
        } left-0`}
    >
      <div className="flex h-full items-center justify-between gap-6 px-6 sm:px-10">
        {/* Left: hamburger + search */}
        <div className="flex flex-1 items-center gap-4 lg:max-w-2xl">
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 text-white/50 transition-colors hover:bg-white/5 hover:text-white lg:hidden"
            aria-label="Open navigation"
          >
            <span className="material-symbols-outlined text-[20px]">menu</span>
          </button>

          {/* Search */}

        </div>

        {/* Right: actions + avatar */}
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="hidden items-center gap-2 sm:flex">
            <button
              type="button"
              className="h-10 w-10 inline-flex items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/5 hover:text-white"
              aria-label="Alerts"
            >
              <span className="material-symbols-outlined text-[20px]">notifications</span>
            </button>
            <button
              type="button"
              className="h-10 w-10 inline-flex items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/5 hover:text-white"
              aria-label="Network Activity"
            >
              <span className="material-symbols-outlined text-[20px]">swap_calls</span>
            </button>
          </div>

          <button
            type="button"
            className="hidden rounded-full border border-white/20 bg-white/10 px-5 py-2.5 font-headline text-[11px] font-bold uppercase tracking-[0.1em] text-white transition-all hover:bg-white hover:text-black md:inline-flex hover:shadow-[0_0_24px_rgba(255,255,255,0.2)]"
          >
            New Team
          </button>

          {/* Avatar / Status Indicator */}
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white/70 shadow-[0_0_12px_rgba(255,255,255,0.05)] cursor-pointer hover:bg-white/10 transition-colors">
            <div className="relative">
              <span className="material-symbols-outlined text-[18px]">person</span>
              <div className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,1)]" />
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

export default TopNav
