import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref } from 'vue'
import { relaunch } from '@tauri-apps/plugin-process'
import localManifest from '../../../../releases/releases.json'

const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/kengqin/book/main/releases/releases.json'
const AUTO_CHECK_KEY = 'novel-library:auto-check-updates'

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
  releaseUrl: string
  installerUrl: string
  sha256: string
  sections: ReleaseSection[]
}

export interface ReleaseManifest {
  schemaVersion: number
  repository: string
  latest: string
  releases: ReleaseEntry[]
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

export type UpdateStage = 'idle' | 'available' | 'downloading' | 'cancelling' | 'downloaded' | 'installing' | 'error'

export const availableUpdate = ref<AvailableUpdate | null>(null)
export const updateChecking = ref(false)
export const updateStage = ref<UpdateStage>('idle')
export const updateProgress = ref(0)
export const updateMessage = ref('')
export const updateError = ref('')

let updateEventListener: Promise<UnlistenFn> | undefined

function describeUpdateError(cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (/valid release JSON|404|failed to fetch|network|connection/i.test(detail)) {
    return '暂时无法连接更新服务，请稍后再试'
  }
  return `检查更新失败：${detail}`
}

export function isAutoCheckEnabled() {
  return localStorage.getItem(AUTO_CHECK_KEY) !== 'false'
}

export function setAutoCheckEnabled(enabled: boolean) {
  localStorage.setItem(AUTO_CHECK_KEY, String(enabled))
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ReleaseManifest>
  return manifest.schemaVersion === 1 && typeof manifest.latest === 'string' && Array.isArray(manifest.releases)
}

export async function loadReleaseManifest(): Promise<{ manifest: ReleaseManifest; remote: boolean }> {
  try {
    const response = await fetch(REMOTE_MANIFEST_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const manifest: unknown = await response.json()
    if (!isReleaseManifest(manifest)) throw new Error('版本清单格式无效')
    return { manifest, remote: true }
  } catch {
    return { manifest: localManifest as ReleaseManifest, remote: false }
  }
}

export async function getCurrentVersion() {
  return getVersion()
}

export function initializeUpdateEvents() {
  if (!updateEventListener) {
    updateEventListener = listen<DownloadProgressEvent>('application-update-download', ({ payload }) => {
      if (payload.status === 'started') {
        updateStage.value = 'downloading'
        updateProgress.value = 0
        updateMessage.value = `正在下载 v${availableUpdate.value?.version || ''}`
      } else if (payload.status === 'downloading') {
        updateStage.value = 'downloading'
        if (payload.total && payload.total > 0) {
          updateProgress.value = Math.min(100, Math.round((payload.downloaded / payload.total) * 100))
        }
      } else if (payload.status === 'downloaded') {
        updateStage.value = 'downloaded'
        updateProgress.value = 100
        updateMessage.value = '下载完成，等待安装'
      } else if (payload.status === 'cancelled') {
        updateStage.value = 'available'
        updateProgress.value = 0
        updateMessage.value = '下载已取消'
      } else if (payload.status === 'error') {
        updateStage.value = 'error'
        updateError.value = describeUpdateError(payload.message || '下载失败')
        updateMessage.value = ''
      }
    })
  }
  return updateEventListener
}

export async function checkForUpdates(silent = false) {
  if (updateChecking.value || ['downloading', 'cancelling', 'downloaded', 'installing'].includes(updateStage.value)) return availableUpdate.value
  updateChecking.value = true
  updateError.value = ''
  if (!silent) updateMessage.value = '正在检查更新...'
  try {
    const update = await invoke<AvailableUpdate | null>('check_application_update')
    availableUpdate.value = update
    updateStage.value = update ? 'available' : 'idle'
    updateMessage.value = update ? `发现新版本 ${update.version}` : '当前已是最新版本'
    return update
  } catch (cause) {
    updateMessage.value = ''
    updateError.value = describeUpdateError(cause)
    return null
  } finally {
    updateChecking.value = false
  }
}

export async function downloadAvailableUpdate() {
  if (!availableUpdate.value || ['downloading', 'cancelling', 'downloaded', 'installing'].includes(updateStage.value)) return
  await initializeUpdateEvents()
  updateStage.value = 'downloading'
  updateProgress.value = 0
  updateError.value = ''
  updateMessage.value = `正在下载 v${availableUpdate.value.version}`
  try {
    await invoke<boolean>('download_application_update')
  } catch (cause) {
    updateStage.value = 'error'
    updateError.value = describeUpdateError(cause)
    updateMessage.value = ''
  }
}

export async function cancelUpdateDownload() {
  if (updateStage.value !== 'downloading') return
  updateStage.value = 'cancelling'
  updateMessage.value = '正在取消下载...'
  try {
    await invoke<boolean>('cancel_application_update_download')
  } catch (cause) {
    updateStage.value = 'error'
    updateError.value = describeUpdateError(cause)
  }
}

export async function installDownloadedUpdate() {
  if (updateStage.value !== 'downloaded') return
  updateStage.value = 'installing'
  updateError.value = ''
  updateMessage.value = '正在安装更新...'
  try {
    await invoke('install_downloaded_application_update')
    updateMessage.value = '安装完成，正在重启...'
    await relaunch()
  } catch (cause) {
    updateStage.value = 'downloaded'
    updateError.value = describeUpdateError(cause)
    updateMessage.value = '更新已下载，可重新安装'
  }
}

export async function dismissUpdate() {
  await invoke('dismiss_application_update')
  availableUpdate.value = null
  updateStage.value = 'idle'
  updateProgress.value = 0
  updateMessage.value = ''
  updateError.value = ''
}

export function compareVersions(left: string, right: string) {
  const normalize = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = normalize(left)
  const b = normalize(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
