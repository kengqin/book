const fs = require('fs')
const os = require('os')
const path = require('path')

function bridgeFile() {
  const root = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(root, 'NovelLibrary', 'bridge.json')
}

function readBridge() {
  return JSON.parse(fs.readFileSync(bridgeFile(), 'utf8'))
}

async function request(route, options = {}) {
  const bridge = readBridge()
  const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${bridge.token}`, Connection: 'close', ...(options.headers || {}) }
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `Bridge request failed: ${response.status}`)
  return payload
}

module.exports = { bridgeFile, readBridge, request }
