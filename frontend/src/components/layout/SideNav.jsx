import { useAtom } from 'jotai'
import { NavLink } from 'react-router-dom'
import {
  navigationLinks,
  sidebarCollapsedAtom,
  sidebarOpenAtom,
} from '../../store/atoms/appAtoms'

function navLinkClassName({ isActive }, sidebarCollapsed) {
  const base =
    'flex items-center gap-3 rounded-lg py-2.5 transition-all duration-200'
  const spacing = sidebarCollapsed ? 'px-3 lg:justify-center lg:px-0' : 'px-3'

  if (isActive) {
    return `${base} ${spacing} border-r-2 border-primary bg-surface-container text-primary`
  }
  return `${base} ${spacing} text-on-surface-variant hover:bg-surface-container hover:text-on-surface`
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
        className={`fixed inset-0 z-40 bg-background/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden ${
          sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={closeSidebar}
      />

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen flex-col bg-surface-container-low shadow-2xl shadow-black/40 transition-[width,transform] duration-300 lg:translate-x-0 ${
          sidebarCollapsed ? 'lg:w-[72px]' : 'lg:w-64'
        } ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} w-64`}
      >
        {/* Collapse toggle (desktop only) */}
        <button
          type="button"
          onClick={toggleCollapse}
          className="absolute -right-3.5 top-9 z-[60] hidden h-7 w-7 items-center justify-center rounded-full border border-outline-variant/40 bg-surface-container text-on-surface-variant shadow-md transition-all hover:border-primary/50 hover:text-primary active:scale-95 lg:flex"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="material-symbols-outlined text-[16px]">
            {sidebarCollapsed ? 'chevron_right' : 'chevron_left'}
          </span>
        </button>

        {/* Brand logo */}
        <div
          className={`flex h-16 shrink-0 items-center gap-3 border-b border-outline-variant/15 px-4 ${
            sidebarCollapsed ? 'lg:justify-center lg:px-0' : ''
          }`}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary-dim shadow-[0_0_14px_rgba(129,236,255,0.3)]">
            <span className="material-symbols-outlined text-base text-background">
              hub
            </span>
          </div>
          <div className={`min-w-0 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
            <h1 className="font-headline text-[17px] font-bold tracking-tight text-on-surface">
              AgentFlow
            </h1>
          </div>
        </div>

        {/* Navigation links */}
        <nav className="custom-scrollbar flex-1 space-y-0.5 overflow-y-auto p-3">
          {navigationLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={(state) => navLinkClassName(state, sidebarCollapsed)}
              onClick={closeSidebar}
              title={sidebarCollapsed ? link.label : undefined}
            >
              <span className="material-symbols-outlined shrink-0 text-[20px]">
                {link.icon}
              </span>
              <span
                className={`font-manrope text-sm font-semibold tracking-tight ${
                  sidebarCollapsed ? 'lg:hidden' : ''
                }`}
              >
                {link.label}
              </span>
            </NavLink>
          ))}
        </nav>

        {/* Footer / Logout */}
        <div className="shrink-0 border-t border-outline-variant/15 p-3">
          <button
            type="button"
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-on-surface-variant transition-all duration-200 hover:bg-surface-container hover:text-on-surface ${
              sidebarCollapsed ? 'lg:justify-center lg:px-0' : ''
            }`}
            title={sidebarCollapsed ? 'Logout' : undefined}
          >
            <span className="material-symbols-outlined shrink-0 text-[20px]">
              logout
            </span>
            <span className={sidebarCollapsed ? 'lg:hidden' : ''}>Logout</span>
          </button>
        </div>
      </aside>
    </>
  )
}

export default SideNav
