import { describe, expect, it } from 'vitest'
import { parseEventStream } from './sse'

function streamFrom(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('SSE parser', () => {
  it('parses events split across arbitrary network chunks', async () => {
    const stream = streamFrom([
      'id: run-1:1\nevent: model.',
      'delta\ndata: {"delta":"hel',
      'lo","stream_seq":1}\n\n',
    ])

    const events = []
    for await (const event of parseEventStream(stream)) events.push(event)

    expect(events).toEqual([{
      data: { delta: 'hello', stream_seq: 1 },
      event: 'model.delta',
      id: 'run-1:1',
    }])
  })

  it('ignores heartbeat comments and supports CRLF plus multiline data', async () => {
    const stream = streamFrom([
      ': ping\r',
      '\n\r\n',
      'event: notice\r\ndata: first\r\ndata: second\r\n\r\n',
    ])

    const events = []
    for await (const event of parseEventStream(stream)) events.push(event)

    expect(events).toEqual([{ data: 'first\nsecond', event: 'notice', id: '' }])
  })
})
