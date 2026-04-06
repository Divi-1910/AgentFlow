import { atom } from 'jotai'

const savedToken = localStorage.getItem('agentflow_token')

export const tokenAtom = atom(savedToken)
export const userAtom = atom(null)

// If we start with a token in memory, we are initializing authentication until /me resolves
export const isInitializingAuthAtom = atom(!!savedToken)
