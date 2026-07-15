import { getVersion } from '@tauri-apps/api/app'
import { ref } from 'vue'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
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

export const availableUpdate = ref<Update | null>(null)
export const updateChecking = ref(false)
export const updateInstalling = ref(false)
export const updateProgress = ref(0)
export const updateMessage = ref('')
export const updateError = ref('')

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

export async function checkForUpdates(silent = false) {
  if (updateChecking.value || updateInstalling.value) return availableUpdate.value
  updateChecking.value = true
  updateError.value = ''
  if (!silent) updateMessage.value = '正在检查更新...'
  try {
    const update = await check({ timeout: 15_000 })
    availableUpdate.value = update
    updateMessage.value = update ? `发现新版本 ${update.version}` : '当前已是最新版本'
    return update
  } catch (cause) {
    updateMessage.value = ''
    updateError.value = cause instanceof Error ? cause.message : String(cause)
    return null
  } finally {
    updateChecking.value = false
  }
}

export async function installAvailableUpdate() {
  const update = availableUpdate.value
  if (!update || updateInstalling.value) return
  updateInstalling.value = true
  updateProgress.value = 0
  updateError.value = ''
  updateMessage.value = `正在下载 ${update.version}...`
  let downloaded = 0
  let total = 0
  const onProgress = (event: DownloadEvent) => {
    if (event.event === 'Started') total = event.data.contentLength ?? 0
    if (event.event === 'Progress') downloaded += event.data.chunkLength
    if (total > 0) updateProgress.value = Math.min(100, Math.round((downloaded / total) * 100))
    if (event.event === 'Finished') {
      updateProgress.value = 100
      updateMessage.value = '更新已下载，正在安装...'
    }
  }
  try {
    await update.downloadAndInstall(onProgress, { timeout: 120_000 })
    updateMessage.value = '安装完成，正在重启...'
    await relaunch()
  } catch (cause) {
    updateError.value = cause instanceof Error ? cause.message : String(cause)
    updateMessage.value = ''
    updateInstalling.value = false
  }
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
