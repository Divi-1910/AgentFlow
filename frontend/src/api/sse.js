function decodeEvent(lines) {
  let event = 'message'
  let id = ''
  const data = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value
    if (field === 'id' && !value.includes('\0')) id = value
    if (field === 'data') data.push(value)
  }

  if (data.length === 0) return null
  const rawData = data.join('\n')
  let parsedData = rawData
  try {
    parsedData = JSON.parse(rawData)
  } catch {
    // SSE permits plain-text data. Keep it intact when it is not JSON.
  }

  return { data: parsedData, event, id }
}

export async function* parseEventStream(stream, { signal } = {}) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lines = []

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      let lineBreak = buffer.search(/[\r\n]/)
      while (lineBreak !== -1) {
        if (!done && buffer[lineBreak] === '\r' && lineBreak === buffer.length - 1) break
        const line = buffer.slice(0, lineBreak)
        const lineBreakLength = buffer[lineBreak] === '\r' && buffer[lineBreak + 1] === '\n' ? 2 : 1
        buffer = buffer.slice(lineBreak + lineBreakLength)
        if (line === '') {
          const decoded = decodeEvent(lines)
          if (decoded) yield decoded
          lines = []
        } else {
          lines.push(line)
        }
        lineBreak = buffer.search(/[\r\n]/)
      }

      if (done) break
    }

    if (buffer) lines.push(buffer)
    const decoded = decodeEvent(lines)
    if (decoded) yield decoded
  } finally {
    reader.releaseLock()
  }
}
