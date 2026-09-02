const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const CLIENT_PROTOCOL_VERSION = 2
let cachedInstalledBridge = null
let localProcess
let providerSettings = {
  useDesktopLibrary: true,
  localDataDirectory: null,
  runtimePath: null,
  logLevel: 'info',
  retainManagedSource: true
}
let validatedSession
let currentProviderIdentity

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

function defaultLocalDataDirectory() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(root, 'NovelLibrary', 'local-data')
}

function localDataDirectory() {
  return providerSettings.localDataDirectory || defaultLocalDataDirectory()
}

function localBridgeFile() {
  return path.join(localDataDirectory(), 'local-runtime.json')
}

function sharedRuntimeRoot() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(root, 'NovelLibrary', 'runtime')
}

function configureProvider(settings = {}) {
  const previousDirectory = localDataDirectory()
  providerSettings = {
    ...providerSettings,
    ...settings,
    useDesktopLibrary: settings.useDesktopLibrary === undefined
      ? providerSettings.useDesktopLibrary
      : settings.useDesktopLibrary !== false
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'localDataDirectory') && path.resolve(localDataDirectory()) !== path.resolve(previousDirectory)) {
    stopLocalRuntime()
  }
  validatedSession = undefined
  currentProviderIdentity = undefined
  return { ...providerSettings, localDataDirectory: localDataDirectory() }
}

function getProviderSettings() {
  return { ...providerSettings, localDataDirectory: localDataDirectory() }
}

function getProviderIdentity() {
  if (currentProviderIdentity) return currentProviderIdentity
  try {
    const bridge = readBridge()
    if (typeof bridge.storageId === 'string' && bridge.storageId) {
      return `${providerSettings.useDesktopLibrary ? 'desktop' : 'local'}:${bridge.storageId}`
    }
  } catch { /* discovery may be temporarily unavailable */ }
  return providerSettings.useDesktopLibrary
    ? 'desktop:legacy'
    : `local:unresolved:${path.resolve(localDataDirectory()).toLowerCase()}`
}

function readBridgeFile(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Number.isInteger(payload.port) || payload.port <= 0 || typeof payload.token !== 'string' || !payload.token) {
    throw new Error('Bridge discovery file is invalid')
  }
  return payload
}

function readBridge() {
  return readBridgeFile(providerSettings.useDesktopLibrary ? bridgeFile() : localBridgeFile())
}

function bundledRuntimeArtifact() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`本地 Runtime 当前支持 Windows x64；当前平台为 ${process.platform}-${process.arch}`)
  }
  const executable = path.join(__dirname, 'runtime', 'win32-x64', 'novel-library-runtime.exe')
  const manifestPath = path.join(__dirname, 'runtime-manifest.json')
  const sidecarPath = `${executable}.sha256`
  if (!fs.existsSync(executable) || !fs.existsSync(manifestPath) || !fs.existsSync(sidecarPath)) {
    throw new Error('插件内 Runtime 或完整性清单缺失，请重新安装插件')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const artifact = manifest.artifacts?.find(item => item.platform === 'win32' && item.arch === 'x64')
  const sidecarHash = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0]?.toLowerCase()
  if (!artifact || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.runtimeVersion || '') || !Number.isInteger(manifest.protocolVersion) || !Number.isInteger(manifest.minimumProtocolVersion) || manifest.minimumProtocolVersion < 1 || manifest.minimumProtocolVersion > manifest.protocolVersion || !/^[a-f0-9]{64}$/.test(sidecarHash || '')) {
    throw new Error('插件内 Runtime manifest 无效，请重新安装插件')
  }
  return { executable, manifestPath, sidecarPath, manifest, hash: artifact.sha256?.toLowerCase(), sidecarHash }
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function validateRuntimeExecutable(executable, expectedVersion, expectedHash) {
  if (!fs.existsSync(executable) || fileSha256(executable) !== expectedHash) return false
  try {
    return execFileSync(executable, ['version'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim() === expectedVersion
  } catch {
    return false
  }
}

function compareRuntimeVersions(left, right) {
  const parts = value => value.split(/[+-]/, 1)[0].split('.').map(Number)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function isRuntimeCompatible(runtime, clientProtocolVersion = CLIENT_PROTOCOL_VERSION) {
  const protocolVersion = Number(runtime?.protocolVersion)
  const minimumClientProtocolVersion = Number(runtime?.minimumClientProtocolVersion ?? 1)
  return Number.isInteger(protocolVersion)
    && Number.isInteger(minimumClientProtocolVersion)
    && protocolVersion >= clientProtocolVersion
    && minimumClientProtocolVersion <= clientProtocolVersion
}

function readActiveRuntime(root) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(active.runtimeVersion || '') || !/^[a-f0-9]{64}$/.test(active.sha256 || '')) return null
    const expected = path.join(root, 'versions', active.runtimeVersion, 'novel-library-runtime.exe')
    if (path.resolve(active.executable || '') !== path.resolve(expected)) return null
    return validateRuntimeExecutable(expected, active.runtimeVersion, active.sha256)
      ? { ...active, minimumClientProtocolVersion: Number(active.minimumClientProtocolVersion ?? 1), executable: expected }
      : null
  } catch {
    return null
  }
}

function acquireInstallLock(root) {
  fs.mkdirSync(root, { recursive: true })
  const lock = path.join(root, 'install.lock')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
      return lock
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 2 * 60 * 1000) {
          fs.rmSync(lock, { force: true })
          continue
        }
      } catch { /* another process is replacing the lock */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  throw new Error('等待共享 Runtime 安装锁超时')
}

function writeActiveRuntime(root, payload) {
  const activePath = path.join(root, 'active.json')
  const temporary = `${activePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const backup = `${activePath}.bak`
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' })
  let backedUp = false
  try {
    if (fs.existsSync(activePath)) {
      fs.rmSync(backup, { force: true })
      fs.renameSync(activePath, backup)
      backedUp = true
    }
    fs.renameSync(temporary, activePath)
    if (backedUp) fs.rmSync(backup, { force: true })
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    if (backedUp && !fs.existsSync(activePath)) fs.renameSync(backup, activePath)
    throw error
  }
}

function installBundledRuntime() {
  const bundled = bundledRuntimeArtifact()
  const actualHash = fileSha256(bundled.executable)
  const version = bundled.manifest.runtimeVersion
  if (bundled.hash !== actualHash || bundled.sidecarHash !== actualHash || !validateRuntimeExecutable(bundled.executable, version, actualHash)) {
    throw new Error('插件内 Runtime 完整性或版本校验失败，请重新安装插件')
  }
  const root = sharedRuntimeRoot()
  let lock
  try {
    lock = acquireInstallLock(root)
    const active = readActiveRuntime(root)
    if (active && compareRuntimeVersions(active.runtimeVersion, version) > 0) {
      if (isRuntimeCompatible(active)) return active.executable
      const error = new Error('共享 Runtime 版本高于当前插件且协议不兼容，请更新插件')
      error.code = 'PROTOCOL_INCOMPATIBLE'
      throw error
    }
    const versionDirectory = path.join(root, 'versions', version)
    const target = path.join(versionDirectory, 'novel-library-runtime.exe')
    if (!validateRuntimeExecutable(target, version, actualHash)) {
      const temporaryDirectory = path.join(root, 'versions', `.${version}.${process.pid}.${crypto.randomUUID()}.tmp`)
      fs.mkdirSync(temporaryDirectory, { recursive: true })
      const temporaryRuntime = path.join(temporaryDirectory, 'novel-library-runtime.exe')
      fs.copyFileSync(bundled.executable, temporaryRuntime)
      fs.copyFileSync(bundled.sidecarPath, `${temporaryRuntime}.sha256`)
      fs.copyFileSync(bundled.manifestPath, path.join(temporaryDirectory, 'runtime-manifest.json'))
      if (!validateRuntimeExecutable(temporaryRuntime, version, actualHash)) throw new Error('共享 Runtime 临时制品校验失败')
      if (fs.existsSync(versionDirectory)) {
        const invalid = `${versionDirectory}.invalid.${Date.now()}`
        fs.renameSync(versionDirectory, invalid)
      }
      fs.renameSync(temporaryDirectory, versionDirectory)
    }
    writeActiveRuntime(root, {
      schemaVersion: 1,
      runtimeVersion: version,
      protocolVersion: bundled.manifest.protocolVersion,
      minimumClientProtocolVersion: bundled.manifest.minimumProtocolVersion,
      executable: target,
      sha256: actualHash,
      previousVersion: active?.runtimeVersion !== version ? active?.runtimeVersion : active?.previousVersion,
      updatedAt: Date.now()
    })
    return target
  } catch (error) {
    const fallback = readActiveRuntime(root)
    if (fallback && isRuntimeCompatible(fallback)) return fallback.executable
    throw error
  } finally {
    if (lock) fs.rmSync(lock, { force: true })
  }
}

function runtimeExecutable() {
  const override = providerSettings.runtimePath || process.env.NOVEL_LIBRARY_RUNTIME
  if (override) {
    if (!fs.existsSync(override)) throw new Error('配置的本地 Runtime 不存在')
    return override
  }
  return installBundledRuntime()
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stopLocalRuntime() {
  if (localProcess && localProcess.exitCode === null) {
    try { localProcess.kill() } catch { /* another IDE may still own the Runtime */ }
  }
  localProcess = undefined
}

async function shutdownLocalRuntime() {
  const discovery = localBridgeFile()
  let bridge
  if (fs.existsSync(discovery)) {
    try {
      bridge = readBridgeFile(discovery)
      await fetch(`http://127.0.0.1:${bridge.port}/v2/runtime/restart`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bridge.token}` },
        signal: AbortSignal.timeout(1500)
      })
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!fs.existsSync(discovery)) break
        await wait(50)
      }
    } catch {
      // Fall back to terminating only the process started by this extension host.
    }
  }
  stopLocalRuntime()
  if (bridge) {
    try {
      const health = await fetch(`http://127.0.0.1:${bridge.port}/v1/health`, { signal: AbortSignal.timeout(500) })
      if (health.ok) throw new Error('本地 Runtime 仍在运行，无法安全迁移数据目录')
    } catch (error) {
      if (error.message?.includes('仍在运行')) throw error
    }
  }
  validatedSession = undefined
}

function beginLocalDataMigration(directory) {
  const root = path.resolve(directory)
  fs.mkdirSync(root, { recursive: true })
  const lock = path.join(root, 'migration.lock')
  if (fs.existsSync(lock)) {
    const age = Date.now() - fs.statSync(lock).mtimeMs
    if (age < 10 * 60 * 1000) throw new Error('本地书库正在被其他客户端迁移')
    fs.rmSync(lock, { force: true })
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
  return lock
}

function endLocalDataMigration(lock) {
  if (lock) fs.rmSync(lock, { force: true })
}

async function ensureLocalRuntime() {
  fs.mkdirSync(localDataDirectory(), { recursive: true })
  if (fs.existsSync(localBridgeFile())) {
    try {
      const bridge = readBridgeFile(localBridgeFile())
      const health = await fetch(`http://127.0.0.1:${bridge.port}/v1/health`, { signal: AbortSignal.timeout(800) })
      if (health.ok) {
        try {
          await validateBridge(bridge)
          return bridge
        } catch (error) {
          if (error.code === 'PROTOCOL_INCOMPATIBLE') throw error
          await shutdownLocalRuntime().catch(() => {})
        }
      }
    } catch {
      // A stale discovery file is replaced below.
    }
  }
  if (!localProcess || localProcess.exitCode !== null) {
    const executable = runtimeExecutable()
    localProcess = spawn(executable, ['serve', '--data-dir', localDataDirectory(), '--port', '0', '--log-level', providerSettings.logLevel || 'info'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    localProcess.unref()
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const bridge = readBridgeFile(localBridgeFile())
      const health = await fetch(`http://127.0.0.1:${bridge.port}/v1/health`, { signal: AbortSignal.timeout(800) })
      if (health.ok) return bridge
    } catch {
      // Runtime is still starting.
    }
    await wait(100)
  }
  throw new Error(`本地书库 Runtime 启动超时：${localDataDirectory()}`)
}

async function validateBridge(bridge) {
  const key = `${providerSettings.useDesktopLibrary ? 'desktop' : 'local'}:${bridge.sessionId || bridge.port}:${bridge.storageId || ''}:${bridge.token}`
  if (validatedSession === key) return
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/manifest`, {
    headers: { Authorization: `Bearer ${bridge.token}` },
    signal: AbortSignal.timeout(3000)
  })
  const manifest = await response.json()
  if (!response.ok) throw new Error(manifest.error?.message || manifest.error || `Bridge manifest failed: ${response.status}`)
  if (providerSettings.useDesktopLibrary && manifest.providerType && manifest.providerType !== 'desktop') throw new Error('当前连接不是桌面端书库')
  if (!providerSettings.useDesktopLibrary && manifest.providerType !== 'local') throw new Error('当前连接不是本地书库 Runtime')
  if (!Number.isInteger(manifest.protocolVersion) || manifest.protocolVersion < 1) throw new Error('Bridge 协议版本无效')
  if (Number(manifest.minimumClientProtocolVersion || 1) > CLIENT_PROTOCOL_VERSION) {
    const error = new Error('Bridge 协议不兼容，请更新插件')
    error.code = 'PROTOCOL_INCOMPATIBLE'
    throw error
  }
  if (providerSettings.useDesktopLibrary) {
    const requiredCapabilities = ['books', 'chapters', 'progress']
    if (!Array.isArray(manifest.capabilities) || requiredCapabilities.some(capability => !manifest.capabilities.includes(capability))) {
      throw new Error('桌面端 Bridge 缺少插件所需能力，请更新桌面端')
    }
    if (bridge.sessionId && manifest.sessionId && bridge.sessionId !== manifest.sessionId) {
      throw new Error('桌面端 Bridge 会话已失效，请重试连接')
    }
  } else {
    const requiredCapabilities = ['books.read', 'chapters.read', 'progress.v2', 'import.jobs', 'import.idempotency', 'backup.transfer', 'runtime.diagnostics', 'runtime.check-database', 'epub.structure.v2']
    if (manifest.protocolVersion < CLIENT_PROTOCOL_VERSION || manifest.minimumClientProtocolVersion > CLIENT_PROTOCOL_VERSION) {
      const error = new Error('本地 Runtime 协议不兼容，请更新插件')
      error.code = 'PROTOCOL_INCOMPATIBLE'
      throw error
    }
    if (typeof manifest.storageId !== 'string' || !manifest.storageId || bridge.storageId !== manifest.storageId) throw new Error('本地书库 storageId 不匹配')
    if (!Array.isArray(manifest.capabilities) || requiredCapabilities.some(capability => !manifest.capabilities.includes(capability))) {
      throw new Error('本地 Runtime 缺少插件所需能力，请更新插件')
    }
    const statusResponse = await fetch(`http://127.0.0.1:${bridge.port}/v2/runtime/status`, {
      headers: { Authorization: `Bearer ${bridge.token}` },
      signal: AbortSignal.timeout(3000)
    })
    const status = await statusResponse.json()
    if (!statusResponse.ok || status.providerType !== 'local' || status.protocolVersion < 2 || status.storageId !== manifest.storageId || path.resolve(status.dataDirectory || '') !== path.resolve(localDataDirectory())) {
      throw new Error('本地 Runtime 数据目录与当前配置不匹配')
    }
  }
  currentProviderIdentity = `${providerSettings.useDesktopLibrary ? 'desktop' : 'local'}:${manifest.storageId || bridge.storageId || 'legacy'}`
  validatedSession = key
}

function copyDirectory(source, target) {
  if (!source || !fs.existsSync(source)) return false
  const sourceRoot = path.resolve(source)
  const targetRoot = path.resolve(target)
  if (sourceRoot === targetRoot) return false
  const sourcePrefix = (sourceRoot.endsWith(path.sep) ? sourceRoot : `${sourceRoot}${path.sep}`).toLowerCase()
  const targetPrefix = (targetRoot.endsWith(path.sep) ? targetRoot : `${targetRoot}${path.sep}`).toLowerCase()
  if (sourcePrefix.startsWith(targetPrefix) || targetPrefix.startsWith(sourcePrefix)) {
    throw new Error('本地书库目录不能是源目录或其子目录')
  }
  const hasDatabase = fs.existsSync(path.join(sourceRoot, 'library.db'))
  const targetHasDatabase = fs.existsSync(path.join(targetRoot, 'library.db'))
  if (!hasDatabase) return false
  if (targetHasDatabase) throw new Error('目标目录已包含本地书库，不能覆盖；请选择空目录或直接切换')
  const ignored = new Set(['runtime.lock', 'migration.lock', 'local-runtime.json', 'local-runtime.json.tmp'])
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const sourcePath = path.join(from, entry.name)
      const targetPath = path.join(to, entry.name)
      if (entry.isDirectory()) copy(sourcePath, targetPath)
      else fs.copyFileSync(sourcePath, targetPath)
    }
  }
  copy(sourceRoot, targetRoot)
  return true
}

function setLocalDataDirectory(directory, options = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('本地数据目录不能为空')
  const target = path.resolve(directory.trim())
  fs.mkdirSync(target, { recursive: true })
  const source = options.copyFrom && path.resolve(options.copyFrom)
  const copied = source ? copyDirectory(source, target) : false
  providerSettings.localDataDirectory = target
  validatedSession = undefined
  return { directory: target, copied }
}

async function waitForImportJob(jobId, options = {}) {
  const timeoutMs = options.timeoutMs || 5 * 60 * 1000
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const job = await request(`/v2/import-jobs/${encodeURIComponent(jobId)}`)
    if (typeof options.onProgress === 'function') options.onProgress(job)
    if (job.state === 'completed') return job
    if (job.state === 'failed' || job.state === 'cancelled') throw new Error(job.message || '导入失败')
    await wait(200)
  }
  throw new Error('导入任务等待超时')
}

async function importFile(filePath, options = {}) {
  if (providerSettings.useDesktopLibrary) {
    await request('/v1/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    })
    return { state: 'accepted', providerType: 'desktop' }
  }
  const job = await request('/v2/import-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      options: options.parseOptions,
      retainSource: options.retainSource ?? providerSettings.retainManagedSource !== false,
      idempotencyKey: options.idempotencyKey || `${path.resolve(filePath)}:${Date.now()}`
    })
  })
  return waitForImportJob(job.id, options)
}

async function reparseBook(bookId, options = {}) {
  if (providerSettings.useDesktopLibrary) throw new Error('重新解析仅适用于本地书库')
  const job = await request(`/v2/books/${encodeURIComponent(bookId)}/reparse`, { method: 'POST' })
  return waitForImportJob(job.id, options)
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
  const bridge = providerSettings.useDesktopLibrary ? readBridge() : await ensureLocalRuntime()
  await validateBridge(bridge)
  const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${bridge.token}`, Connection: 'close', ...(options.headers || {}) }
  })
  const payload = await response.json()
  if (!response.ok) {
    const detail = typeof payload.error === 'object' ? payload.error.message : payload.error
    const error = new Error(detail || `Bridge request failed: ${response.status}`)
    error.code = typeof payload.error === 'object' ? payload.error.code : undefined
    error.status = response.status
    throw error
  }
  return payload
}

async function restartLocalRuntime() {
  if (providerSettings.useDesktopLibrary) throw new Error('当前是桌面端模式')
  await request('/v2/runtime/restart', { method: 'POST' })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const bridge = readBridgeFile(localBridgeFile())
      await fetch(`http://127.0.0.1:${bridge.port}/v1/health`, { signal: AbortSignal.timeout(200) })
      await wait(100)
    } catch {
      break
    }
  }
  localProcess = undefined
  validatedSession = undefined
  await wait(150)
  return ensureLocalRuntime()
}

module.exports = {
  __testInstallBundledRuntime: installBundledRuntime,
  __testIsRuntimeCompatible: isRuntimeCompatible,
  __testReadActiveRuntime: readActiveRuntime,
  __testSharedRuntimeRoot: sharedRuntimeRoot,
  beginLocalDataMigration,
  bridgeFile,
  configureProvider,
  defaultLocalDataDirectory,
  endLocalDataMigration,
  getProviderSettings,
  getProviderIdentity,
  importFile,
  openDesktopApp,
  readBridge,
  request,
  reparseBook,
  restartLocalRuntime,
  setLocalDataDirectory,
  shutdownLocalRuntime,
  stopLocalRuntime
}
