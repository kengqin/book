import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createWheelBridge } = require('./wheel-bridge')

test('accepts authenticated loopback wheel messages only', async () => {
  const moves = []
  const chapters = []
  let ready
  const listening = new Promise(resolve => { ready = resolve })
  const bridge = createWheelBridge(
    direction => moves.push(direction),
    ready,
    direction => chapters.push(direction)
  )
  await listening
  const { port, token } = bridge.address()
  assert.ok(port > 0)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/novel-library-wheel/${token}`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send('1')
  socket.send('-1')
  socket.send('chapter:-1')
  socket.send('chapter:1')
  socket.send('invalid')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(moves, [1, -1])
  assert.deepEqual(chapters, [-1, 1])
  socket.close()
  bridge.dispose()
})
