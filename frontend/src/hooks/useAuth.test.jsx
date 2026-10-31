import { act, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest } from '../api/client'
import {
  authErrorAtom,
  isInitializingAuthAtom,
  tokenAtom,
  userAtom,
} from '../store/atoms/authAtoms'
import { useAuth } from './useAuth'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal()),
  apiRequest: vi.fn(),
}))

function renderAuthHook(store = createStore()) {
  function Wrapper({ children }) {
    return (
      <Provider store={store}>
        <MemoryRouter>{children}</MemoryRouter>
      </Provider>
    )
  }

  return {
    ...renderHook(() => useAuth(), { wrapper: Wrapper }),
    store,
  }
}

describe('useAuth', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('stores the token and authenticated user after login', async () => {
    const user = {
      id: 'user-1',
      email: 'divi@example.com',
      first_name: 'Divi',
      last_name: 'Muley',
    }
    apiRequest
      .mockResolvedValueOnce({ token: 'signed-token' })
      .mockResolvedValueOnce({ user })

    const { result, store } = renderAuthHook()
    await act(async () => {
      await result.current.login('divi@example.com', 'password')
    })

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/auth/login', {
      method: 'POST',
      json: { email: 'divi@example.com', password: 'password' },
    })
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/auth/me', {
      token: 'signed-token',
    })
    expect(store.get(tokenAtom)).toBe('signed-token')
    expect(store.get(userAtom)).toEqual(user)
    expect(localStorage.getItem('agentflow_token')).toBe('signed-token')
  })

  it('clears an expired session when the backend returns unauthorized', async () => {
    const store = createStore()
    store.set(tokenAtom, 'expired-token')
    store.set(userAtom, { id: 'user-1' })
    store.set(isInitializingAuthAtom, true)
    store.set(authErrorAtom, null)
    localStorage.setItem('agentflow_token', 'expired-token')
    apiRequest.mockRejectedValue(new ApiError('unauthorized', { status: 401 }))

    const { result } = renderAuthHook(store)
    await act(async () => {
      await result.current.loadMe('expired-token')
    })

    expect(store.get(tokenAtom)).toBeNull()
    expect(store.get(userAtom)).toBeNull()
    expect(store.get(isInitializingAuthAtom)).toBe(false)
    expect(localStorage.getItem('agentflow_token')).toBeNull()
  })
})
