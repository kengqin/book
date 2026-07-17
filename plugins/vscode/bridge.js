const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
let cachedInstalledBridge = null

function legacyBridgeFile() {
  const root = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(root, 'NovelLibrary', 'bridge.json')
}

function installedBridgeFile() {
  if (process.platform !== 'win32') return null
  if (cachedInstalledBridge && fs.existsSync(cachedInstalledBridge)) return cachedInstalledBridge
  try {
    const executable = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$names = @('novel-library-desktop', 'NovelLibrary'); $p = Get-Process | Where-Object { $names -contains $_.ProcessName } | Select-Object -First 1; if ($p) { $p.Path }"
    ], { encoding: 'utf8', timeout: 2000 }).trim()
    if (!executable) return null
    const candidate = path.join(path.dirname(executable), 'bridge.json')
    cachedInstalledBridge = fs.existsSync(candidate) ? candidate : null
    return cachedInstalledBridge
  } catch {
    return null
  }
}

function bridgeFile() {
  return installedBridgeFile() || legacyBridgeFile()
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
