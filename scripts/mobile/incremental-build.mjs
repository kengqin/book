import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptFile), '../..')
const mobileRoot = join(repoRoot, 'apps/mobile')
const androidRoot = join(mobileRoot, 'android')
const iosRoot = join(mobileRoot, 'ios/App')
const cacheRoot = join(repoRoot, '.release-local/mobile-build-cache')
const lockFile = join(cacheRoot, 'build.lock')
const recordSchema = 1

const workspacePackages = [
  'packages/novel-parser',
  'packages/reader-core',
  'packages/reader-protocol',
  'packages/storage-web'
]

function normalizedPath(value) {
  return value.split(sep).join('/')
}

function commandName(base) {
  return process.platform === 'win32' ? `${base}.cmd` : base
}

function isTestFile(file) {
  const name = normalizedPath(file)
  return /(?:^|\/)(?:test-fixtures|__tests__)(?:\/|$)/u.test(name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name)
}

async function pathKind(path) {
  try {
    const value = await stat(path)
    return value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function collectFiles(paths, exclude = () => false) {
  const files = []
  const missing = []

  async function visit(path) {
    if (exclude(path)) return
    const kind = await pathKind(path)
    if (kind === 'missing') {
      missing.push(path)
      return
    }
    if (kind === 'file') {
      files.push(path)
      return
    }
    if (kind !== 'directory') return

    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      await visit(join(path, entry.name))
    }
  }

  for (const path of [...new Set(paths.map(value => resolve(value)))].sort()) await visit(path)
  files.sort()
  missing.sort()
  return { files, missing }
}

export async function fingerprintPaths(paths, {
  base = repoRoot,
  exclude = () => false,
  extra = []
} = {}) {
  const { files, missing } = await collectFiles(paths, exclude)
  const hash = createHash('sha256')
  for (const value of [...extra].sort()) hash.update(`extra\0${value}\0`)
  for (const path of missing) hash.update(`missing\0${normalizedPath(relative(base, path))}\0`)
  let bytes = 0
  for (const path of files) {
    const content = await readFile(path)
    const name = normalizedPath(relative(base, path))
    bytes += content.byteLength
    hash.update(`file\0${name}\0${content.byteLength}\0`)
    hash.update(content)
    hash.update('\0')
  }
  return { hash: hash.digest('hex'), files: files.length, bytes }
}

async function snapshotArtifact(path, base) {
  const kind = await pathKind(path)
  if (kind === 'missing') return undefined
  if (kind === 'file') {
    const content = await readFile(path)
    return {
      path: normalizedPath(relative(base, path)),
      kind,
      bytes: content.byteLength,
      hash: createHash('sha256').update(content).digest('hex')
    }
  }
  if (kind === 'directory') {
    const fingerprint = await fingerprintPaths([path], { base })
    return {
      path: normalizedPath(relative(base, path)),
      kind,
      files: fingerprint.files,
      bytes: fingerprint.bytes,
      hash: fingerprint.hash
    }
  }
  return undefined
}

async function snapshotArtifacts(paths, base) {
  const output = []
  for (const path of paths) {
    const snapshot = await snapshotArtifact(path, base)
    if (!snapshot) throw new Error(`构建产物不存在：${path}`)
    output.push(snapshot)
  }
  return output
}

export async function saveBuildRecord(recordFile, { inputHash, outputs, label = '' }, base = repoRoot) {
  const artifacts = await snapshotArtifacts(outputs, base)
  const record = {
    schema: recordSchema,
    label,
    inputHash,
    completedAt: new Date().toISOString(),
    artifacts
  }
  await mkdir(dirname(recordFile), { recursive: true })
  const temporary = `${recordFile}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temporary, recordFile)
  return record
}

export async function inspectBuildRecord(recordFile, { inputHash, outputs }, base = repoRoot) {
  let record
  try {
    record = JSON.parse(await readFile(recordFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { reusable: false, reason: '没有缓存记录' }
    return { reusable: false, reason: '缓存记录损坏' }
  }
  if (record.schema !== recordSchema) return { reusable: false, reason: '缓存版本已变化' }
  if (record.inputHash !== inputHash) return { reusable: false, reason: '输入文件发生变化' }
  if (!Array.isArray(record.artifacts) || record.artifacts.length !== outputs.length) {
    return { reusable: false, reason: '产物清单发生变化' }
  }

  for (let index = 0; index < outputs.length; index += 1) {
    const current = await snapshotArtifact(outputs[index], base)
    const cached = record.artifacts[index]
    if (!current) return { reusable: false, reason: `产物缺失：${normalizedPath(relative(base, outputs[index]))}` }
    if (
      current.path !== cached.path ||
      current.kind !== cached.kind ||
      current.hash !== cached.hash ||
      current.bytes !== cached.bytes ||
      current.files !== cached.files
    ) {
      return { reusable: false, reason: `产物已被修改：${current.path}` }
    }
  }
  return { reusable: true, reason: '输入和产物均未变化', record }
}

function runCommand(command, args, cwd, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)
    const executable = isWindowsScript ? (process.env.ComSpec || 'cmd.exe') : command
    const executableArgs = isWindowsScript ? ['/d', '/s', '/c', command, ...args] : args
    const child = spawn(executable, executableArgs, { cwd, env: environment, stdio: 'inherit', shell: false })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${command} ${args.join(' ')} 执行失败（${signal ? `signal ${signal}` : `exit ${code}`}）`))
    })
  })
}

function readWindowsUserEnvironment(name) {
  if (process.platform !== 'win32') return ''
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true })
    const line = output.split(/\r?\n/u).find(value => value.trimStart().startsWith(name))
    return line?.trim().split(/\s{2,}/u).at(-1)?.trim() ?? ''
  } catch {
    return ''
  }
}

function gradleEnvironment() {
  const environment = { ...process.env }
  environment.GRADLE_USER_HOME = environment.GRADLE_USER_HOME || readWindowsUserEnvironment('GRADLE_USER_HOME')
  environment.ANDROID_HOME = environment.ANDROID_HOME || readWindowsUserEnvironment('ANDROID_HOME')
  environment.ANDROID_SDK_ROOT = environment.ANDROID_SDK_ROOT || readWindowsUserEnvironment('ANDROID_SDK_ROOT') || environment.ANDROID_HOME
  return environment
}

async function runCachedStep({ id, label, inputs, outputs, exclude, extra, force, run }) {
  const startedAt = Date.now()
  const fingerprint = await fingerprintPaths(inputs, { base: repoRoot, exclude, extra })
  const recordFile = join(cacheRoot, `${id}.json`)
  const state = force
    ? { reusable: false, reason: '已要求强制重建' }
    : await inspectBuildRecord(recordFile, { inputHash: fingerprint.hash, outputs }, repoRoot)

  if (state.reusable) {
    console.log(`[复用] ${label}：${state.reason}`)
    for (const output of outputs) console.log(`       ${normalizedPath(relative(repoRoot, output))}`)
    return { rebuilt: false, inputHash: fingerprint.hash }
  }

  console.log(`[构建] ${label}：${state.reason}（${fingerprint.files} 个输入文件）`)
  await run()
  await saveBuildRecord(recordFile, { inputHash: fingerprint.hash, outputs, label }, repoRoot)
  console.log(`[完成] ${label}：${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`)
  return { rebuilt: true, inputHash: fingerprint.hash }
}

function webInputs() {
  return [
    scriptFile,
    join(repoRoot, 'package.json'),
    join(repoRoot, 'package-lock.json'),
    join(mobileRoot, 'package.json'),
    join(mobileRoot, 'index.html'),
    join(mobileRoot, 'tsconfig.json'),
    join(mobileRoot, 'vite.config.ts'),
    join(mobileRoot, 'src'),
    ...workspacePackages.flatMap(path => [join(repoRoot, path, 'package.json'), join(repoRoot, path, 'src')])
  ]
}

async function ensureWeb(force) {
  if (ensureWeb.current) return ensureWeb.current
  ensureWeb.current = runCachedStep({
    id: 'web',
    label: '移动端 Web 资源',
    inputs: webInputs(),
    outputs: [join(mobileRoot, 'dist')],
    exclude: isTestFile,
    force,
    run: () => runCommand(commandName('npm'), ['run', 'build:raw', '--workspace', '@novel-library/mobile'], repoRoot)
  })
  return ensureWeb.current
}

async function ensureNativeSync(force) {
  if (ensureNativeSync.current) return ensureNativeSync.current
  await ensureWeb(force)
  ensureNativeSync.current = runCachedStep({
    id: `native-sync-${process.platform}`,
    label: 'Capacitor Android/iOS 原生同步',
    inputs: [
      scriptFile,
      join(repoRoot, 'package-lock.json'),
      join(mobileRoot, 'package.json'),
      join(mobileRoot, 'capacitor.config.ts'),
      join(mobileRoot, 'dist')
    ],
    outputs: [
      join(androidRoot, 'app/src/main/assets/public'),
      join(androidRoot, 'app/src/main/assets/capacitor.config.json'),
      join(androidRoot, 'app/src/main/assets/capacitor.plugins.json'),
      join(iosRoot, 'App/public'),
      join(iosRoot, 'App/capacitor.config.json')
    ],
    extra: [process.platform],
    force,
    run: () => runCommand(commandName('npm'), ['run', 'native:sync:raw', '--workspace', '@novel-library/mobile'], repoRoot)
  })
  return ensureNativeSync.current
}

function excludeAndroidBuildOutput(path) {
  const name = normalizedPath(relative(androidRoot, path))
  return /(?:^|\/)(?:\.gradle|build|\.idea)(?:\/|$)/u.test(name) ||
    name === 'local.properties' ||
    /(?:^|\/)\.gitignore$/u.test(name)
}

async function ensureAndroid(variant, force) {
  await ensureNativeSync(force)
  const release = variant === 'release'
  const output = join(androidRoot, `app/build/outputs/apk/${variant}/app-${variant}.apk`)
  const signingInputs = release
    ? [
        join(repoRoot, '.release-local/android-signing/novel-library-release.jks'),
        join(repoRoot, '.release-local/android-signing/signing.properties')
      ]
    : []

  return runCachedStep({
    id: `android-${variant}`,
    label: `Android ${release ? 'Release' : 'Debug'} APK`,
    inputs: [scriptFile, androidRoot, ...signingInputs],
    outputs: [output],
    exclude: excludeAndroidBuildOutput,
    extra: [variant],
    force,
    run: async () => {
      const gradle = process.platform === 'win32' ? join(androidRoot, 'gradlew.bat') : './gradlew'
      await runCommand(gradle, [release ? 'assembleRelease' : 'assembleDebug', '--console=plain'], androidRoot, gradleEnvironment())
      if (release && process.platform === 'win32') {
        await runCommand(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts/android/verify-release-signing.ps1'), '-Apk', output],
          repoRoot,
          gradleEnvironment()
        )
      }
    }
  })
}

function excludeIosBuildOutput(path) {
  const name = normalizedPath(relative(iosRoot, path))
  return /(?:^|\/)(?:Pods|build|DerivedData)(?:\/|$)/u.test(name) ||
    /^App\/public(?:\/|$)/u.test(name)
}

function requireMac(label) {
  if (process.platform !== 'darwin') throw new Error(`${label} 只能在安装了 Xcode 的 macOS 上执行。`)
}

async function ensureIosSimulator(force) {
  requireMac('iOS 模拟器打包')
  await ensureNativeSync(force)
  const derivedData = join(cacheRoot, 'ios-simulator-derived-data')
  const appBundle = join(derivedData, 'Build/Products/Debug-iphonesimulator/App.app')
  return runCachedStep({
    id: 'ios-simulator',
    label: 'iOS Simulator App',
    inputs: [scriptFile, iosRoot],
    outputs: [appBundle],
    exclude: excludeIosBuildOutput,
    extra: ['iphonesimulator'],
    force,
    run: () => runCommand('xcodebuild', [
      '-workspace', 'App.xcworkspace',
      '-scheme', 'App',
      '-configuration', 'Debug',
      '-sdk', 'iphonesimulator',
      '-derivedDataPath', derivedData,
      'build'
    ], iosRoot)
  })
}

async function ensureIosArchive(force) {
  requireMac('iOS Archive 打包')
  await ensureNativeSync(force)
  const archive = join(cacheRoot, 'ios-archive/App.xcarchive')
  return runCachedStep({
    id: 'ios-archive',
    label: 'iOS Release Archive',
    inputs: [scriptFile, iosRoot],
    outputs: [archive],
    exclude: excludeIosBuildOutput,
    extra: ['iphoneos', 'release'],
    force,
    run: () => runCommand('xcodebuild', [
      '-workspace', 'App.xcworkspace',
      '-scheme', 'App',
      '-configuration', 'Release',
      '-destination', 'generic/platform=iOS',
      '-archivePath', archive,
      '-allowProvisioningUpdates',
      'archive'
    ], iosRoot)
  })
}

async function acquireLock() {
  await mkdir(cacheRoot, { recursive: true })
  try {
    const handle = await open(lockFile, 'wx')
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    return handle
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`已有移动端打包任务正在运行：${lockFile}`)
    throw error
  }
}

async function main() {
  const mode = process.argv[2] ?? 'android-release'
  const force = process.argv.includes('--force') || process.env.MOBILE_FORCE_REBUILD === '1'
  if (mode === 'clear-cache') {
    await rm(cacheRoot, { recursive: true, force: true })
    console.log(`已清除移动端增量打包缓存：${cacheRoot}`)
    return
  }

  const supported = new Set([
    'web', 'native-sync', 'android-debug', 'android-release', 'android-all',
    'ios-simulator', 'ios-archive'
  ])
  if (!supported.has(mode)) throw new Error(`不支持的移动端打包模式：${mode}`)

  const lock = await acquireLock()
  try {
    if (mode === 'web') await ensureWeb(force)
    if (mode === 'native-sync') await ensureNativeSync(force)
    if (mode === 'android-debug') await ensureAndroid('debug', force)
    if (mode === 'android-release') await ensureAndroid('release', force)
    if (mode === 'android-all') {
      await ensureAndroid('debug', force)
      await ensureAndroid('release', force)
    }
    if (mode === 'ios-simulator') await ensureIosSimulator(force)
    if (mode === 'ios-archive') await ensureIosArchive(force)
  } finally {
    await lock.close()
    await unlink(lockFile).catch(() => undefined)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[失败] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
