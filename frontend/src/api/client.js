import { apiURL } from './config'

export class ApiError extends Error {
  constructor(message, { status = 0, data = null, cause } = {}) {
    super(message, { cause })
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function decodeResponse(response) {
  const text = await response.text()
  if (!text) return null

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch (cause) {
      throw new ApiError('The server returned invalid JSON.', {
        status: response.status,
        cause,
      })
    }
  }
  return text
}

async function performRequest(
  path,
  {
    accept = 'application/json',
    token,
    json,
    headers,
    onUnauthorized,
    signal,
    ...requestInit
  } = {},
) {
  const requestHeaders = new Headers(headers)
  requestHeaders.set('Accept', accept)

  if (token) requestHeaders.set('Authorization', `Bearer ${token}`)
  if (json !== undefined) requestHeaders.set('Content-Type', 'application/json')

  let response
  try {
    response = await fetch(apiURL(path), {
      ...requestInit,
      headers: requestHeaders,
      body: json === undefined ? requestInit.body : JSON.stringify(json),
      signal,
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new ApiError('Unable to reach AgentFlow. Check that the backend is running.', {
      cause,
    })
  }

  if (!response.ok) {
    const data = await decodeResponse(response)
    if (response.status === 401) onUnauthorized?.()
    throw new ApiError(errorMessage(data, response.status), {
      status: response.status,
      data,
    })
  }

  return response
}

function errorMessage(data, status) {
  if (typeof data === 'string' && data.trim()) return data.trim()
  if (data && typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim()
  }
  if (data && typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim()
  }
  return `Request failed with status ${status}.`
}

export async function apiRequest(
  path,
  {
    token,
    json,
    headers,
    onUnauthorized,
    signal,
    ...requestInit
  } = {},
) {
  const response = await performRequest(path, {
    token,
    json,
    headers,
    onUnauthorized,
    signal,
    ...requestInit,
  })
  return decodeResponse(response)
}

export async function apiStreamRequest(path, options = {}) {
  const response = await performRequest(path, {
    ...options,
    accept: 'text/event-stream',
  })
  if (!response.body) {
    throw new ApiError('The server did not provide a readable event stream.', {
      status: response.status,
    })
  }
  return response.body
}

function attachmentFilename(response, fallback) {
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1])
    } catch {
      // Fall through to the ordinary filename or the caller-provided fallback.
    }
  }
  const quoted = disposition.match(/filename="([^"]+)"/i)
  const plain = disposition.match(/filename=([^;\s]+)/i)
  return quoted?.[1] || plain?.[1] || fallback
}

export async function apiDownloadRequest(path, { filename = 'agentflow-download', ...options } = {}) {
  const response = await performRequest(path, options)
  return {
    blob: await response.blob(),
    filename: attachmentFilename(response, filename),
  }
}

export function createApiClient({ getToken, onUnauthorized } = {}) {
  const request = (path, options = {}) => apiRequest(path, {
    ...options,
    token: options.token ?? getToken?.(),
    onUnauthorized,
  })
  const stream = (path, options = {}) => apiStreamRequest(path, {
    ...options,
    token: options.token ?? getToken?.(),
    onUnauthorized,
  })
  const download = (path, options = {}) => apiDownloadRequest(path, {
    ...options,
    token: options.token ?? getToken?.(),
    onUnauthorized,
  })

  return Object.freeze({
    download,
    request,
    stream,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, json, options) => request(path, { ...options, method: 'POST', json }),
    patch: (path, json, options) => request(path, { ...options, method: 'PATCH', json }),
    put: (path, json, options) => request(path, { ...options, method: 'PUT', json }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
  })
}
