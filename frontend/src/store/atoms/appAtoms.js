import { atom } from 'jotai'

export const navigationLinks = [
  { to: '/', label: 'Home', icon: 'dashboard', end: true },
  { to: '/agents', label: 'Agent Library', icon: 'smart_toy' },
  { to: '/teams', label: 'Team Library', icon: 'group_work' },
  { to: '/chat', label: 'Chat', icon: 'forum' },
]

export const sidebarOpenAtom = atom(false)
export const sidebarCollapsedAtom = atom(false)
export const globalSearchAtom = atom('')
