const crypto = require('crypto')
const net = require('net')

function websocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
}

function parseHeaders(payload) {
  const lines = payload.split('\r\n')
  const request = lines.shift() || ''
  const headers = new Map()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  return { request, headers }
}

function decodeFrames(buffer, onMessage) {
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = Boolean(second & 0x80)
    let length = second & 0x7f
    let headerLength = 2
    if (length === 126) {
      if (buffer.length - offset < 4) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      return { remaining: Buffer.alloc(0), close: true }
    }
    if (!masked || length > 4096) return { remaining: Buffer.alloc(0), close: true }
    const frameLength = headerLength + 4 + length
    if (buffer.length - offset < frameLength) break
    const maskOffset = offset + headerLength
    const payloadOffset = maskOffset + 4
    const payload = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[payloadOffset + index] ^ buffer[maskOffset + (index % 4)]
    }
    offset += frameLength
    if (opcode === 0x8) return { remaining: buffer.subarray(offset), close: true }
    if (opcode === 0x1) onMessage(payload.toString('utf8'))
  }
  return { remaining: buffer.subarray(offset), close: false }
}

function createWheelBridge(onMove, onReady = () => {}, onChapter = () => {}) {
  const token = crypto.randomBytes(18).toString('hex')
  const sockets = new Set()
  let port = 0
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let upgraded = false
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          if (buffer.length > 8192) socket.destroy()
          return
        }
        const { request, headers } = parseHeaders(buffer.subarray(0, headerEnd).toString('utf8'))
        const expectedRequest = `GET /novel-library-wheel/${token} HTTP/1.1`
        const key = headers.get('sec-websocket-key')
        if (request !== expectedRequest || !key || headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          return
        }
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
          '\r\n'
        ].join('\r\n'))
        upgraded = true
        buffer = buffer.subarray(headerEnd + 4)
      }
      const decoded = decodeFrames(buffer, message => {
        if (message === '1' || message === '-1') {
          Promise.resolve(onMove(Number(message))).catch(() => {})
        } else if (message === 'chapter:1' || message === 'chapter:-1') {
          Promise.resolve(onChapter(Number(message.slice('chapter:'.length)))).catch(() => {})
        }
      })
      buffer = decoded.remaining
      if (decoded.close) socket.end()
    })
  })
  server.on('error', () => {})
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    port = typeof address === 'object' && address ? address.port : 0
    onReady()
  })
  server.unref()
  return {
    markerCss() {
      return `--novel-library-wheel: 1; --novel-library-wheel-port: ${port}; --novel-library-wheel-token: ${token};`
    },
    navigationCss(options = {}) {
      return `--novel-library-navigation: 1; --novel-library-previous-enabled: ${options.previousEnabled ? 1 : 0}; --novel-library-next-enabled: ${options.nextEnabled ? 1 : 0}; cursor: pointer;`
    },
    address() {
      return { port, token }
    },
    dispose() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.close()
    }
  }
}

module.exports = { createWheelBridge }
