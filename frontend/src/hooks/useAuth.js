import { useAtom } from 'jotai'
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { tokenAtom, userAtom, isInitializingAuthAtom } from '../store/atoms/authAtoms'

const API_URL = 'http://localhost:9090/api/auth'

export function useAuth() {
  const [token, setToken] = useAtom(tokenAtom)
  const [user, setUser] = useAtom(userAtom)
  const [isInitializing, setIsInitializing] = useAtom(isInitializingAuthAtom)
  const navigate = useNavigate()

  const saveToken = (newToken) => {
    if (newToken) {
      console.log("saving new token")
      localStorage.setItem('agentflow_token', newToken)
    } else {
      console.log("removing token")
      localStorage.removeItem('agentflow_token')
    }
    setToken(newToken)
  }

  const login = async (email, password) => {
    const res = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || 'Login failed')
    }

    const data = await res.json()
    saveToken(data.token)
    await loadMe(data.token)
    navigate('/dashboard')
  }

  const signup = async (firstName, lastName, email, password) => {
    const res = await fetch(`${API_URL}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email, password })
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || 'Signup failed')
    }

    // Auto-login after successful signup
    await login(email, password)
  }

  const loadMe = useCallback(async (currentToken = token) => {
    if (!currentToken) {
      setIsInitializing(false)
      return
    }
    try {
      const res = await fetch(`${API_URL}/me`, {
        headers: { 'Authorization': `Bearer ${currentToken}` }
      })
      if (!res.ok) throw new Error('Invalid token')

      const data = await res.json()
      setUser(data.user)
    } catch (err) {
      console.log("Error fetching user : ", err)
      saveToken(null)
      setUser(null)
    } finally {
      setIsInitializing(false)
    }
  }, [token, setToken, setUser, setIsInitializing])

  const logout = () => {
    saveToken(null)
    setUser(null)
    navigate('/login')
  }

  return { token, user, isInitializing, login, signup, loadMe, logout }
}
