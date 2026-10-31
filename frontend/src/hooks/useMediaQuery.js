import { useCallback, useSyncExternalStore } from 'react'

export function useMediaQuery(query) {
  const subscribe = useCallback((onStoreChange) => {
    const mediaQuery = window.matchMedia(query)
    mediaQuery.addEventListener('change', onStoreChange)
    return () => mediaQuery.removeEventListener('change', onStoreChange)
  }, [query])

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
