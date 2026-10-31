import { useAtomValue } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useLocation, useOutlet } from 'react-router-dom'
import { sidebarCollapsedAtom } from '../../store/atoms/appAtoms'
import SideNav from './SideNav'
import TopNav from './TopNav'

function AppShell() {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const { pathname } = useLocation()
  const outlet = useOutlet()
  const reduceMotion = useReducedMotion()
  const isSpatialWorkspace = pathname === '/agents'
    || /^\/agents\/[^/]+$/.test(pathname)
    || pathname === '/teams'
    || /^\/teams\/[^/]+$/.test(pathname)
    || pathname === '/chat'
  const contentKey = isSpatialWorkspace ? 'spatial-workspace' : 'application-content'

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
          <AnimatePresence initial={false} mode="wait">
            <motion.main
              key={contentKey}
              className={isSpatialWorkspace ? 'flex-1 overflow-hidden' : 'flex-1 px-6 py-10 sm:px-10 lg:px-12'}
              initial={reduceMotion || !isSpatialWorkspace ? false : { opacity: 0, scale: 0.997, filter: 'blur(3px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              exit={reduceMotion || !isSpatialWorkspace ? undefined : { opacity: 0, scale: 1.003, filter: 'blur(3px)' }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              {outlet}
            </motion.main>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

export default AppShell
