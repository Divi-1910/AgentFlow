import { useAtom } from 'jotai'
import { NavLink } from 'react-router-dom'
import {
  navigationLinks,
  sidebarCollapsedAtom,
  sidebarOpenAtom,
} from '../../store/atoms/appAtoms'

function navLinkClassName({ isActive }, sidebarCollapsed) {
  const base =
    'group relative flex items-center gap-4 rounded-2xl py-3.5 transition-all duration-500 overflow-hidden'
  const spacing = sidebarCollapsed ? 'px-0 justify-center' : 'px-5'

  if (isActive) {
    return `${base} ${spacing} bg-white/[0.06] text-white shadow-[0_4px_24px_-8px_rgba(0,0,0,0.5)] border border-white/5`
  }
  return `${base} ${spacing} text-white/40 border border-transparent hover:bg-white/[0.02] hover:text-white hover:border-white/5 hover:shadow-[0_4px_24px_-8px_rgba(0,0,0,0.5)]`
}

function SideNav() {
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)

  const closeSidebar = () => setSidebarOpen(false)
  const toggleCollapse = () => setSidebarCollapsed((c) => !c)

  return (
    <>
      {/* Mobile backdrop overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/80 backdrop-blur-md transition-opacity duration-300 lg:hidden ${
          sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={closeSidebar}
      />

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen flex-col bg-black/40 backdrop-blur-[40px] border-r border-white/10 transition-[width,transform] duration-300 lg:translate-x-0 ${
          sidebarCollapsed ? 'lg:w-[88px]' : 'lg:w-72'
        } ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} w-72`}
      >
        {/* Collapse toggle (desktop only) */}
        <button
          type="button"
          onClick={toggleCollapse}
          className="absolute -right-3.5 top-8 z-[60] hidden h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black text-white/50 shadow-[0_0_16px_rgba(255,255,255,0.1)] transition-all hover:border-white/50 hover:text-white hover:scale-110 active:scale-95 lg:flex"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="material-symbols-outlined text-[14px]">
            {sidebarCollapsed ? 'chevron_right' : 'chevron_left'}
          </span>
        </button>

        {/* Brand logo */}
        <div className="relative flex h-24 shrink-0 items-center justify-center border-b border-white/5 overflow-hidden">
          {/* Logo Icon (Visible when collapsed) */}
          <div
            className={`absolute flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-[0_0_32px_rgba(255,255,255,0.25)] transition-all duration-300 ${
              sidebarCollapsed ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
            }`}
          >
            <span className="material-symbols-outlined text-[20px] text-black">
              hive
            </span>
          </div>

          {/* Text Brand (Visible when expanded) */}
          <div
            className={`absolute left-8 transition-all duration-300 ${
              sidebarCollapsed ? 'opacity-0 -translate-x-4 pointer-events-none' : 'opacity-100 translate-x-0'
            }`}
          >
            <h1 className="font-headline text-[24px] font-extrabold tracking-tight text-white leading-none whitespace-nowrap">
              Agent<span className="italic font-light text-white/50">Flow</span>
            </h1>
          </div>
        </div>

        {/* Navigation links */}
        <nav className="flex-1 space-y-2 overflow-y-auto p-4 custom-scrollbar">
          {navigationLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={(state) => navLinkClassName(state, sidebarCollapsed)}
              onClick={closeSidebar}
              title={sidebarCollapsed ? link.label : undefined}
            >
              {({ isActive }) => (
                <>
                  {/* Subtle active indicator orb */}
                  {isActive && (
                    <div className="absolute left-0 top-1/2 h-[40%] w-1 -translate-y-1/2 rounded-r-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.8)]" />
                  )}
                  
                  <span className={`material-symbols-outlined shrink-0 text-[20px] transition-all duration-500 ${isActive ? 'text-white' : 'text-white/50'} ${!sidebarCollapsed && 'group-hover:-rotate-6 group-hover:scale-110 group-hover:text-white'}`}>
                    {link.icon}
                  </span>
                  
                  <span
                    className={`font-headline text-[11px] font-bold uppercase tracking-[0.15em] transition-all duration-500 ${!sidebarCollapsed && 'group-hover:translate-x-1 group-hover:text-white'} ${
                      sidebarCollapsed ? 'lg:hidden' : ''
                    }`}
                  >
                    {link.label}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Footer / Logout */}
        <div className="shrink-0 p-5 pb-6">
          <div className="group rounded-2xl border border-white/5 bg-white/[0.02] transition-colors hover:bg-white/[0.04]">
            <button
              type="button"
              className={`flex w-full items-center gap-4 rounded-2xl p-4 font-headline text-[11px] font-bold uppercase tracking-[0.15em] text-white/50 transition-all duration-300 hover:text-white ${
                sidebarCollapsed ? 'lg:justify-center px-0' : ''
              }`}
              title={sidebarCollapsed ? 'Logout' : undefined}
            >
              <span className="material-symbols-outlined shrink-0 text-[20px] transition-transform duration-300 group-hover:text-white group-hover:-rotate-12">
                power_settings_new
              </span>
              <span className={`transition-all duration-300 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>Logout</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

export default SideNav
