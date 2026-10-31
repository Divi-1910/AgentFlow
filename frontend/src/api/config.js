const configuredBaseURL = import.meta.env.VITE_API_BASE_URL?.trim()

export const API_BASE_URL = (configuredBaseURL || '/api').replace(/\/$/, '')

export function apiURL(path) {
  if (/^https?:\/\//i.test(path)) return path
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE_URL}${normalizedPath}`
}
