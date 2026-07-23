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

function openDesktopApp() {
  if (process.platform !== 'win32') throw new Error('当前平台暂不支持自动打开桌面端')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$names = @('novel-library-desktop', 'NovelLibrary')",
    '$process = Get-Process | Where-Object { $names -contains $_.ProcessName } | Select-Object -First 1',
    'if ($process) {',
    "  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NovelLibraryWindow { [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'",
    '  $process.Refresh()',
    '  if ($process.MainWindowHandle -eq 0) { throw "无法定位小说书库窗口" }',
    '  [NovelLibraryWindow]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null',
    '  [NovelLibraryWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null',
    '  exit 0',
    '}',
    "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$installed = Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^(NovelLibrary|小说书库)$' } | Select-Object -First 1",
    "$directory = ([string]$installed.InstallLocation).Trim('\"')",
    "$icon = (([string]$installed.DisplayIcon).Split(',')[0]).Trim('\"')",
    "$candidates = @((Join-Path $directory 'novel-library-desktop.exe'), $icon) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }",
    '$executable = $candidates | Select-Object -First 1',
    'if (-not $executable) { throw "未找到小说书库桌面端，请先安装桌面应用" }',
    'Start-Process -FilePath $executable'
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  })
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

module.exports = { bridgeFile, openDesktopApp, readBridge, request }
