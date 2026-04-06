import { useAtom, useAtomValue } from 'jotai'
import {
  globalSearchAtom,
  sidebarCollapsedAtom,
  sidebarOpenAtom,
} from '../../store/atoms/appAtoms'
import { useAuth } from '../../hooks/useAuth'

function TopNav() {
  const [searchQuery, setSearchQuery] = useAtom(globalSearchAtom)
  const [, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const { user } = useAuth()

  const getInitials = () => {
    if (!user) return ''
    return `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
  }

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

        </div>

        {/* Right: actions + avatar */}
        <div className="flex items-center gap-3 sm:gap-4">
          {user ? (
            <div className="flex items-center gap-4 pl-2 sm:pl-4 border-white/10 ml-2">
              <div className="hidden flex-col items-end text-right sm:flex">
                <span className="font-headline text-[11px] font-bold uppercase tracking-[0.15em] text-white">
                  {user.first_name} {user.last_name}
                </span>
                <span className="text-[10px] font-medium tracking-wide text-white/30">
                  {user.email}
                </span>
              </div>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white/90 shadow-[0_0_16px_rgba(255,255,255,0.05)] transition-all hover:bg-white/10 cursor-pointer hover:shadow-[0_0_24px_rgba(255,255,255,0.1)]">
                <span className="font-headline text-[13px] font-bold tracking-widest ml-[2px]">
                  {getInitials()}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white/70 shadow-[0_0_12px_rgba(255,255,255,0.05)] cursor-pointer hover:bg-white/10 transition-colors">
              <div className="relative">
                <span className="material-symbols-outlined text-[18px]">person</span>
                <div className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,1)]" />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

export default TopNav
