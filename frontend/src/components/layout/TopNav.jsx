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
      className={`fixed right-0 top-0 z-40 h-16 border-b border-outline-variant/15 bg-background/80 backdrop-blur-xl transition-[left] duration-300 ${
        sidebarCollapsed ? 'lg:left-[72px]' : 'lg:left-64'
      } left-0`}
    >
      <div className="flex h-full items-center justify-between gap-4 px-4 sm:px-6">
        {/* Left: hamburger + search */}
        <div className="flex flex-1 items-center gap-3 lg:max-w-lg">
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-outline-variant/30 text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface lg:hidden"
            aria-label="Open navigation"
          >
            <span className="material-symbols-outlined text-[20px]">menu</span>
          </button>

          {/* Search */}
          <div className="relative w-full">
            <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-outline">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search commands, agents, logs…"
              className="w-full rounded-lg border border-outline-variant/20 bg-surface-container py-2 pl-9 pr-4 text-sm text-on-surface outline-none placeholder:text-outline focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all"
            />
          </div>
        </div>

        {/* Right: actions + avatar */}
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-1 sm:flex">
            <button
              type="button"
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              aria-label="Notifications"
            >
              <span className="material-symbols-outlined text-[20px]">notifications</span>
            </button>
            <button
              type="button"
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              aria-label="History"
            >
              <span className="material-symbols-outlined text-[20px]">history</span>
            </button>
          </div>

          <button
            type="button"
            className="hidden rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 md:inline-flex"
          >
            New Team
          </button>

          {/* Avatar */}
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/25 bg-gradient-to-br from-secondary/30 to-primary/30 text-on-surface">
            <span className="material-symbols-outlined text-[18px]">person</span>
          </div>
        </div>
      </div>
    </header>
  )
}

export default TopNav
