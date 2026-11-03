import { atom } from 'jotai'

export const navigationLinks = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/agents', label: 'Agent Library', icon: 'smart_toy' },
  { to: '/teams', label: 'Team Library', icon: 'group_work' },
  { to: '/templates', label: 'Templates', icon: 'dashboard_customize' },
  { to: '/chat', label: 'Chat', icon: 'forum' },
  { to: '/deployments', label: 'Deployments', icon: 'deployed_code' },
]

export const sidebarOpenAtom = atom(false)
export const sidebarCollapsedAtom = atom(false)
export const globalSearchAtom = atom('')
