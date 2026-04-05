import { useAtomValue } from 'jotai'
import { Outlet } from 'react-router-dom'
import { sidebarCollapsedAtom } from '../../store/atoms/appAtoms'
import SideNav from './SideNav'
import TopNav from './TopNav'

function AppShell() {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#000000] font-body text-white selection:bg-white/30 selection:text-white">
      {/* Background Ambience */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-30">

        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/50 to-black" />
      </div>

      <div className="relative z-10 flex min-h-screen">
        <SideNav />
        <TopNav />

        {/* Main content — offset matches sidebar width and topnav height */}
        <div
          className={`flex w-full flex-col pt-24 transition-[padding-left] duration-300 ${sidebarCollapsed ? 'lg:pl-[88px]' : 'lg:pl-72'
            }`}
        >
          <main className="flex-1 px-6 py-10 sm:px-10 lg:px-12">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}

export default AppShell
