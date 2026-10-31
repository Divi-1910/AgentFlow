import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query) => ({
    addEventListener: () => {},
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => {},
  }),
  writable: true,
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})
