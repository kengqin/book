import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { reactive, ref, toRefs } from 'vue'
import { relaunch } from '@tauri-apps/plugin-process'
import localManifest from '../../../../releases/releases.json'

const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/kengqin/book/main/releases/releases.json'
const OFFICIAL_REPOSITORY = 'kengqin/book'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases/latest`
const AUTO_CHECK_KEY = 'novel-library:auto-check-updates'
const BACKGROUND_CHECK_KEY = 'novel-library:background-check-updates'
const AUTO_DOWNLOAD_KEY = 'novel-library:auto-download-updates'
const RELEASE_MANIFEST_CACHE_KEY = 'novel-library:release-manifest-cache'
const RELEASE_MANIFEST_CACHE_MAX_AGE = 60 * 60 * 1000
const BACKGROUND_CHECK_INTERVAL = 60 * 60 * 1000
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface ReleaseSection {
  title: string
  items: string[]
}

export interface ReleaseEntry {
  version: string
  date: string
  title: string
  channel: 'stable' | 'preview'
  databaseSchema: number
  published: boolean
  minimumSupportedVersion?: string
  requiresBackup?: boolean
  releaseUrl: string
  installerUrl: string
  sha256: string
  sections: ReleaseSection[]
  upgradeNotes: string[]
}

export interface ReleaseManifest {
  schemaVersion: number
  repository: string
  latest: string
  releases: ReleaseEntry[]
}

export type ReleaseManifestSource = 'remote' | 'cached' | 'local'

export interface ReleaseManifestResult {
  manifest: ReleaseManifest
  remote: boolean
  source: ReleaseManifestSource
}

interface ReleaseManifestCache {
  fetchedAt: number
  manifest: ReleaseManifest
}

export interface AvailableUpdate {
  currentVersion: string
  version: string
  date?: string
  body?: string
}

interface DownloadProgressEvent {
  status: 'started' | 'downloading' | 'downloaded' | 'cancelled' | 'error'
  downloaded: number
  total?: number
  message?: string
}

export type UpdateStage =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'cancelling'
  | 'downloaded'
  | 'installing'
  | 'published-but-not-ready'
  | 'manifest-error'
  | 'version-mismatch'
  | 'signature-error'
  | 'download-error'
  | 'install-error'
  | 'relaunch-error'

interface UpdateTaskState {
  stage: UpdateStage
  version: string
  progress: number
  message: string
  error: string
  downloadedBytes: number
  totalBytes: number
  retryCount: number
}

export const availableUpdate = ref<AvailableUpdate | null>(null)
export const updateChecking = ref(false)
export const publishedUpdateVersion = ref<string | null>(null)
export const latestReadyVersion = ref<string | null>(null)
export const updateCompatibilityNote = ref('')
export const updateRequiresBackup = ref(false)
export const updateTask = reactive<UpdateTaskState>({
  stage: 'idle',
  version: '',
  progress: 0,
  message: '',
  error: '',
  downloadedBytes: 0,
  totalBytes: 0,
  retryCount: 0
})
export const {
  stage: updateStage,
  progress: updateProgress,
  message: updateMessage,
  error: updateError,
  downloadedBytes: updateDownloadedBytes,
  totalBytes: updateTotalBytes
} = toRefs(updateTask)

let targetRelease: ReleaseEntry | null = null
let updateEventListener: Promise<UnlistenFn> | undefined
let backgroundCheckTimer: number | undefined
let downloadStarting = false
let manifestRequest: Promise<ReleaseManifestResult> | undefined

function errorDetail(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function userMessageFor(stage: UpdateStage) {
  const messages: Partial<Record<UpdateStage, string>> = {
    'manifest-error': '暂时无法连接更新服务，请稍后重试',
    'published-but-not-ready': '发现新版本，安装包正在准备',
    'version-mismatch': '更新信息尚未同步完成，请稍后重试',
    'signature-error': '更新包校验失败，已阻止安装',
    'download-error': '下载失败，可重试或打开历史版本页面',
    'install-error': '更新包已下载，但安装失败，可重新安装',
    'relaunch-error': '更新已安装，请手动重启应用'
  }
  return messages[stage] || '更新操作失败，请稍后重试'
}

function setFailure(stage: UpdateStage) {
  updateTask.stage = stage
  updateTask.error = userMessageFor(stage)
  updateTask.message = ''
  updateTask.retryCount += 1
  console.error('application-update-error', {
    stage,
    version: updateTask.version,
    manifestUrl: updateTask.version
      ? `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/v${updateTask.version}/latest-windows-x86_64-nsis.json`
      : REMOTE_MANIFEST_URL,
    installerUrl: targetRelease?.installerUrl || '',
    error: stage,
    retryCount: updateTask.retryCount
  })
}

function classifyFailure(cause: unknown, fallback: UpdateStage): UpdateStage {
  const detail = errorDetail(cause)
  if (/VERSION_MISMATCH/i.test(detail)) return 'version-mismatch'
  if (/SIGNATURE_ERROR|DOWNLOAD_URL_NOT_ALLOWED|signature|minisign/i.test(detail)) return 'signature-error'
  return fallback
}

export function isAutoCheckEnabled() {
  return localStorage.getItem(AUTO_CHECK_KEY) !== 'false'
}

export function setAutoCheckEnabled(enabled: boolean) {
  localStorage.setItem(AUTO_CHECK_KEY, String(enabled))
}

export function isBackgroundCheckEnabled() {
  return localStorage.getItem(BACKGROUND_CHECK_KEY) === 'true'
}

export function setBackgroundCheckEnabled(enabled: boolean) {
  localStorage.setItem(BACKGROUND_CHECK_KEY, String(enabled))
  configureBackgroundUpdateChecks()
}

export function isAutoDownloadEnabled() {
  return localStorage.getItem(AUTO_DOWNLOAD_KEY) === 'true'
}

export function setAutoDownloadEnabled(enabled: boolean) {
  localStorage.setItem(AUTO_DOWNLOAD_KEY, String(enabled))
}

export function configureBackgroundUpdateChecks() {
  if (backgroundCheckTimer !== undefined) window.clearInterval(backgroundCheckTimer)
  backgroundCheckTimer = undefined
  if (isBackgroundCheckEnabled()) {
    backgroundCheckTimer = window.setInterval(() => void checkForUpdates(true), BACKGROUND_CHECK_INTERVAL)
  }
}

function parseSemver(value: string) {
  const normalized = value.replace(/^v/, '')
  const match = normalized.match(SEMVER_PATTERN)
  if (!match) throw new Error(`无效版本号：${value}`)
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') || []
  }
}

export function compareVersions(left: string, right: string) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ReleaseManifest>
  if (manifest.schemaVersion !== 1 || manifest.repository !== OFFICIAL_REPOSITORY || !manifest.latest || !Array.isArray(manifest.releases)) return false
  try {
    parseSemver(manifest.latest)
  } catch {
    return false
  }
  const versions = new Set<string>()
  for (const release of manifest.releases) {
    if (!release || typeof release !== 'object') return false
    try {
      parseSemver(release.version)
      if (release.minimumSupportedVersion !== undefined) parseSemver(release.minimumSupportedVersion)
      else if (release.version === manifest.latest) throw new Error('最新版本缺少直接升级基线')
    } catch {
      return false
    }
    if (versions.has(release.version) || typeof release.published !== 'boolean') return false
    if (release.requiresBackup !== undefined && typeof release.requiresBackup !== 'boolean') return false
    if (release.version === manifest.latest && typeof release.requiresBackup !== 'boolean') return false
    if (!Array.isArray(release.sections) || !release.releaseUrl || !release.installerUrl) return false
    versions.add(release.version)
  }
  return manifest.releases[0]?.version === manifest.latest && manifest.releases[0]?.published === true
}

function readManifestCache() {
  try {
    const raw = localStorage.getItem(RELEASE_MANIFEST_CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw) as Partial<ReleaseManifestCache>
    if (!Number.isFinite(cached.fetchedAt) || !isReleaseManifest(cached.manifest)) return null
    return cached as ReleaseManifestCache
  } catch {
    return null
  }
}

function writeManifestCache(manifest: ReleaseManifest) {
  try {
    localStorage.setItem(RELEASE_MANIFEST_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), manifest }))
  } catch {
    // A full or unavailable localStorage should not prevent update checks.
  }
}

export function getCachedReleaseManifest(): { manifest: ReleaseManifest; source: Exclude<ReleaseManifestSource, 'remote'> } {
  const cached = readManifestCache()
  return cached
    ? { manifest: cached.manifest, source: 'cached' }
    : { manifest: localManifest as ReleaseManifest, source: 'local' }
}

async function fetchRemoteReleaseManifest(): Promise<ReleaseManifestResult> {
  const response = await fetch(REMOTE_MANIFEST_URL, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const manifest: unknown = await response.json()
  if (!isReleaseManifest(manifest)) throw new Error('版本清单格式无效')
  writeManifestCache(manifest)
  return { manifest, remote: true, source: 'remote' }
}

export async function loadReleaseManifest(options: { forceRefresh?: boolean; requiredVersion?: string } = {}): Promise<ReleaseManifestResult> {
  const cached = readManifestCache()
  const cacheAge = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY
  const cacheHasRequiredVersion = !options.requiredVersion || cached?.manifest.releases.some((release) => release.version === options.requiredVersion)
  if (!options.forceRefresh && cached && cacheAge < RELEASE_MANIFEST_CACHE_MAX_AGE && cacheHasRequiredVersion) {
    return { manifest: cached.manifest, remote: false, source: 'cached' }
  }

  if (!manifestRequest) manifestRequest = fetchRemoteReleaseManifest()
  try {
    return await manifestRequest
  } catch {
    return cached
      ? { manifest: cached.manifest, remote: false, source: 'cached' }
      : { manifest: localManifest as ReleaseManifest, remote: false, source: 'local' }
  } finally {
    manifestRequest = undefined
  }
}

export async function loadLatestPublishedVersion() {
  const response = await fetch(LATEST_RELEASE_URL, {
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) throw new Error(`正式版本服务不可用：HTTP ${response.status}`)
  const release: unknown = await response.json()
  if (!release || typeof release !== 'object') throw new Error('正式版本信息格式无效')
  const candidate = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
  if (candidate.draft !== false || candidate.prerelease !== false || typeof candidate.tag_name !== 'string' || !candidate.tag_name.startsWith('v')) {
    throw new Error('正式版本信息格式无效')
  }
  const version = candidate.tag_name.slice(1)
  parseSemver(version)
  return version
}

export async function getCurrentVersion() {
  return getVersion()
}

export function initializeUpdateEvents() {
  if (!updateEventListener) {
    updateEventListener = listen<DownloadProgressEvent>('application-update-download', ({ payload }) => {
      updateTask.downloadedBytes = payload.downloaded
      updateTask.totalBytes = payload.total || updateTask.totalBytes
      if (payload.status === 'started') {
        updateTask.stage = 'downloading'
        updateTask.progress = 0
        updateTask.message = `正在下载 v${availableUpdate.value?.version || updateTask.version}`
      } else if (payload.status === 'downloading') {
        updateTask.stage = 'downloading'
        if (payload.total && payload.total > 0) {
          updateTask.progress = Math.min(100, Math.round((payload.downloaded / payload.total) * 100))
        }
      } else if (payload.status === 'downloaded') {
        updateTask.stage = 'downloaded'
        updateTask.progress = 100
        updateTask.message = '下载完成，等待安装'
      } else if (payload.status === 'cancelled') {
        updateTask.stage = 'available'
        updateTask.progress = 0
        updateTask.downloadedBytes = 0
        updateTask.totalBytes = 0
        updateTask.message = '下载已取消'
      } else if (payload.status === 'error') {
        setFailure(classifyFailure(payload.message || '', 'download-error'))
      }
    })
  }
  return updateEventListener
}

export async function checkForUpdates(silent = false) {
  const busy = ['downloading', 'cancelling', 'downloaded', 'installing'].includes(updateTask.stage)
  if (updateChecking.value || busy) return availableUpdate.value
  updateChecking.value = true
  updateTask.error = ''
  if (!silent) updateTask.message = '正在检查更新...'
  let expectedVersion: string | null = null
  try {
    const currentVersion = await getCurrentVersion()
    expectedVersion = await loadLatestPublishedVersion()
    const hasNewerVersion = compareVersions(expectedVersion, currentVersion) > 0
    updateTask.version = hasNewerVersion ? expectedVersion : ''

    const update = await invoke<AvailableUpdate | null>('check_application_update', { expectedVersion })
    if (update && compareVersions(update.version, expectedVersion) !== 0) {
      throw new Error(`VERSION_MISMATCH: expected ${expectedVersion}, received ${update.version}`)
    }
    if (hasNewerVersion && !update) {
      throw new Error(`MANIFEST_NOT_READY: v${expectedVersion} 的更新 Manifest 尚不可用`)
    }
    if (!hasNewerVersion && update) {
      throw new Error(`VERSION_MISMATCH: v${expectedVersion} 不应高于当前版本 v${currentVersion}`)
    }

    latestReadyVersion.value = expectedVersion
    publishedUpdateVersion.value = null
    const { manifest } = await loadReleaseManifest({ forceRefresh: !silent, requiredVersion: expectedVersion })
    targetRelease = hasNewerVersion ? manifest.releases.find((release) => release.version === expectedVersion) || null : null
    updateRequiresBackup.value = Boolean(targetRelease?.requiresBackup)
    updateCompatibilityNote.value = targetRelease?.minimumSupportedVersion && compareVersions(currentVersion, targetRelease.minimumSupportedVersion) < 0
      ? `当前版本低于直接升级基线 v${targetRelease.minimumSupportedVersion}，建议先导出完整备份。`
      : targetRelease?.requiresBackup
        ? '此版本升级前需要先导出完整备份。'
        : ''

    if (!hasNewerVersion) {
      availableUpdate.value = null
      updateTask.stage = 'idle'
      updateTask.message = compareVersions(currentVersion, expectedVersion) > 0
        ? `当前版本高于正式发布版本 v${expectedVersion}`
        : '当前已是最新版本'
      return null
    }
    const readyUpdate = update as AvailableUpdate
    availableUpdate.value = readyUpdate
    updateTask.stage = 'available'
    updateTask.message = `发现新版本 ${readyUpdate.version}`
    updateTask.error = ''
    if (silent && isAutoDownloadEnabled() && !targetRelease?.requiresBackup && !updateCompatibilityNote.value) {
      void downloadAvailableUpdate(true)
    }
    return readyUpdate
  } catch (cause) {
    availableUpdate.value = null
    publishedUpdateVersion.value = null
    targetRelease = null
    updateRequiresBackup.value = false
    updateCompatibilityNote.value = ''
    updateTask.version = expectedVersion || ''
    setFailure(classifyFailure(cause, 'manifest-error'))
    return null
  } finally {
    updateChecking.value = false
  }
}

export async function downloadAvailableUpdate(automatic = false, backupConfirmed = false) {
  const blocked = ['downloading', 'cancelling', 'downloaded', 'installing'].includes(updateTask.stage)
  if (!availableUpdate.value || blocked || downloadStarting) return
  downloadStarting = true
  try {
    if (targetRelease?.requiresBackup) {
      if (automatic || !backupConfirmed) return
    }
    await initializeUpdateEvents()
    updateTask.stage = 'downloading'
    updateTask.progress = 0
    updateTask.downloadedBytes = 0
    updateTask.totalBytes = 0
    updateTask.error = ''
    updateTask.message = `正在下载 v${availableUpdate.value.version}`
    try {
      await invoke<boolean>('download_application_update')
    } catch (cause) {
      setFailure(classifyFailure(cause, 'download-error'))
    }
  } finally {
    downloadStarting = false
  }
}

export async function cancelUpdateDownload() {
  if (updateTask.stage !== 'downloading') return
  updateTask.stage = 'cancelling'
  updateTask.message = '正在取消下载...'
  try {
    await invoke<boolean>('cancel_application_update_download')
  } catch {
    setFailure('download-error')
  }
}

export async function installDownloadedUpdate() {
  if (!['downloaded', 'install-error'].includes(updateTask.stage)) return
  updateTask.stage = 'installing'
  updateTask.error = ''
  updateTask.message = '正在安装更新...'
  try {
    await invoke('install_downloaded_application_update')
  } catch {
    setFailure('install-error')
    updateTask.message = '更新已下载，可重新安装'
    return
  }
  updateTask.message = '安装完成，正在重启...'
  try {
    await relaunch()
  } catch {
    setFailure('relaunch-error')
  }
}

export async function dismissUpdate() {
  if (['downloading', 'cancelling', 'downloaded', 'installing', 'install-error'].includes(updateTask.stage)) return
  await invoke('dismiss_application_update')
  availableUpdate.value = null
  publishedUpdateVersion.value = null
  targetRelease = null
  updateRequiresBackup.value = false
  updateCompatibilityNote.value = ''
  Object.assign(updateTask, {
    stage: 'idle', version: '', progress: 0, message: '', error: '', downloadedBytes: 0, totalBytes: 0, retryCount: 0
  })
}
