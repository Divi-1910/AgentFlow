import { useAtom } from 'jotai'
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiRequest, ApiError } from '../api/client'
import {
  authErrorAtom,
  isInitializingAuthAtom,
  tokenAtom,
  userAtom,
} from '../store/atoms/authAtoms'

export function useAuth() {
  const [token, setToken] = useAtom(tokenAtom)
  const [user, setUser] = useAtom(userAtom)
  const [isInitializing, setIsInitializing] = useAtom(isInitializingAuthAtom)
  const [authError, setAuthError] = useAtom(authErrorAtom)
  const navigate = useNavigate()

  const saveToken = useCallback((newToken) => {
    if (newToken) {
      localStorage.setItem('agentflow_token', newToken)
    } else {
      localStorage.removeItem('agentflow_token')
    }
    setToken(newToken)
  }, [setToken])

  const invalidateSession = useCallback(() => {
    saveToken(null)
    setUser(null)
    setAuthError(null)
    setIsInitializing(false)
    navigate('/login', { replace: true })
  }, [navigate, saveToken, setAuthError, setIsInitializing, setUser])

  const loadMe = useCallback(async (currentToken = token) => {
    if (!currentToken) {
      setUser(null)
      setAuthError(null)
      setIsInitializing(false)
      return null
    }

    setAuthError(null)
    try {
      const data = await apiRequest('/auth/me', { token: currentToken })
      setUser(data.user)
      return data.user
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        invalidateSession()
        return null
      }
      setAuthError(error.message || 'Unable to verify your session.')
      throw error
    } finally {
      setIsInitializing(false)
    }
  }, [invalidateSession, setAuthError, setIsInitializing, setUser, token])

  const login = useCallback(async (email, password) => {
    setAuthError(null)
    const data = await apiRequest('/auth/login', {
      method: 'POST',
      json: { email, password },
    })

    saveToken(data.token)
    await loadMe(data.token)
    navigate('/dashboard')
  }, [loadMe, navigate, saveToken, setAuthError])

  const signup = useCallback(async (firstName, lastName, email, password) => {
    setAuthError(null)
    await apiRequest('/auth/signup', {
      method: 'POST',
      json: {
        first_name: firstName,
        last_name: lastName,
        email,
        password,
      },
    })

    // Auto-login after successful signup
    await login(email, password)
  }, [login, setAuthError])

  const logout = useCallback(() => invalidateSession(), [invalidateSession])

  return {
    token,
    user,
    isInitializing,
    authError,
    login,
    signup,
    loadMe,
    logout,
    invalidateSession,
  }
}
