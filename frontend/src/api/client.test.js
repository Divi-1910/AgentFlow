import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, apiStreamRequest, createApiClient } from './client'

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
}

describe('API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds authentication and serializes JSON requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'agent-1' }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient({ getToken: () => 'test-token' })
    const result = await client.post('/agents', { name: 'Researcher' })

    expect(result).toEqual({ id: 'agent-1' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/agents')
    expect(request.method).toBe('POST')
    expect(request.body).toBe(JSON.stringify({ name: 'Researcher' }))
    expect(request.headers.get('Authorization')).toBe('Bearer test-token')
    expect(request.headers.get('Content-Type')).toBe('application/json')
  })

  it('surfaces backend error messages with the response status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'agent name is required' },
      { status: 400 },
    )))

    await expect(apiRequest('/agents')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'agent name is required',
      status: 400,
    })
  })

  it('invalidates the session on an unauthorized response', async () => {
    const onUnauthorized = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'unauthorized' },
      { status: 401 },
    )))

    await expect(apiRequest('/workspace/overview', { onUnauthorized })).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('turns network failures into a stable user-facing error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await expect(apiRequest('/workspace/overview')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Unable to reach AgentFlow. Check that the backend is running.',
      status: 0,
    })
  })

  it('opens authenticated event streams without consuming their body', async () => {
    const body = new ReadableStream()
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await apiStreamRequest('/runs/run-1/events', {
      token: 'test-token',
      headers: { 'Last-Event-ID': 'run-1:8' },
    })

    expect(result).toBe(body)
    const [, request] = fetchMock.mock.calls[0]
    expect(request.headers.get('Accept')).toBe('text/event-stream')
    expect(request.headers.get('Authorization')).toBe('Bearer test-token')
    expect(request.headers.get('Last-Event-ID')).toBe('run-1:8')
  })
})
