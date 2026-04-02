import { useAtomValue } from 'jotai'
import { Outlet } from 'react-router-dom'
import { sidebarCollapsedAtom } from '../../store/atoms/appAtoms'
import SideNav from './SideNav'
import TopNav from './TopNav'

function AppShell() {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-on-background">
      <SideNav />
      <TopNav />

      {/* Main content — offset matches sidebar width and topnav height */}
      <div
        className={`flex min-h-screen flex-col pt-16 transition-[padding-left] duration-300 ${
          sidebarCollapsed ? 'lg:pl-[72px]' : 'lg:pl-64'
        }`}
      >
        <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default AppShell
