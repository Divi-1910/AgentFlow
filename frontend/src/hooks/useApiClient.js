import { useMemo } from 'react'
import { createApiClient } from '../api/client'
import { useAuth } from './useAuth'

export function useApiClient() {
  const { token, invalidateSession } = useAuth()

  return useMemo(
    () => createApiClient({
      getToken: () => token,
      onUnauthorized: invalidateSession,
    }),
    [invalidateSession, token],
  )
}
