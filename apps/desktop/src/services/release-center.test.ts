import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getVersionMock, invokeMock, relaunchMock } = vi.hoisted(() => ({
  getVersionMock: vi.fn(),
  invokeMock: vi.fn(),
  relaunchMock: vi.fn()
}))
const localStorageStore = new Map<string, string>()

vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchMock }))
vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStorageStore.get(key) || null,
  setItem: (key: string, value: string) => localStorageStore.set(key, value),
  removeItem: (key: string) => localStorageStore.delete(key)
})

import {
  availableUpdate,
  checkForUpdates,
  compareVersions,
  installDownloadedUpdate,
  isReleaseManifest,
  latestReadyVersion,
  loadReleaseManifest,
  publishedUpdateVersion,
  updateError,
  updateMessage,
  updateStage,
  updateTask
} from './release-center'

function remoteManifest(latest = '0.3.1') {
  return {
    schemaVersion: 1,
    repository: 'kengqin/book',
    latest,
    releases: [{
      version: latest,
      date: '2026-07-17',
      title: 'Test',
      channel: 'stable',
      databaseSchema: 5,
      published: true,
      minimumSupportedVersion: '0.1.0',
      requiresBackup: false,
      releaseUrl: `https://github.com/kengqin/book/releases/tag/v${latest}`,
      installerUrl: `https://github.com/kengqin/book/releases/download/v${latest}/NovelLibrary_${latest}_x64-setup.exe`,
      sha256: 'a'.repeat(64),
      sections: [{ title: 'Fix', items: ['One'] }],
      upgradeNotes: []
    }]
  }
}

function mockRemote(catalogLatest = '0.3.1', publishedLatest = catalogLatest) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input)
    return {
      ok: true,
      json: async () => url.includes('api.github.com')
        ? { tag_name: `v${publishedLatest}`, draft: false, prerelease: false }
        : remoteManifest(catalogLatest)
    }
  }))
}

describe('release center update consistency', () => {
  beforeEach(() => {
    getVersionMock.mockReset()
    invokeMock.mockReset()
    relaunchMock.mockReset()
    localStorageStore.clear()
    availableUpdate.value = null
    publishedUpdateVersion.value = null
    latestReadyVersion.value = null
    Object.assign(updateTask, {
      stage: 'idle', version: '', progress: 0, message: '', error: '', downloadedBytes: 0, totalBytes: 0, retryCount: 0
    })
  })

  it('does not expose a catalog version before it becomes the formal Latest Release', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockResolvedValue(null)
    mockRemote('0.3.1', '0.3.0')

    await checkForUpdates()

    expect(invokeMock).toHaveBeenCalledWith('check_application_update', { expectedVersion: '0.3.0' })
    expect(availableUpdate.value).toBeNull()
    expect(publishedUpdateVersion.value).toBeNull()
    expect(latestReadyVersion.value).toBe('0.3.0')
    expect(updateStage.value).toBe('idle')
    expect(updateMessage.value).toContain('已是最新')
  })

  it('reuses a recently fetched release manifest from local cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => remoteManifest() })
    vi.stubGlobal('fetch', fetchMock)

    const first = await loadReleaseManifest({ forceRefresh: true })
    expect(first.source).toBe('remote')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    const second = await loadReleaseManifest()
    expect(second.source).toBe('cached')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(second.manifest.latest).toBe(first.manifest.latest)
  })

  it('uses the formal Latest Release instead of a newer catalog entry', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockResolvedValue({ currentVersion: '0.3.0', version: '0.3.1' })
    mockRemote('0.3.2', '0.3.1')

    await checkForUpdates()

    expect(invokeMock).toHaveBeenCalledWith('check_application_update', { expectedVersion: '0.3.1' })
    expect(availableUpdate.value?.version).toBe('0.3.1')
    expect(latestReadyVersion.value).toBe('0.3.1')
    expect(updateStage.value).toBe('available')
  })

  it('does not expose a formal release until its fixed-version manifest is readable', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockRejectedValue(new Error('MANIFEST_NOT_READY'))
    mockRemote('0.3.1', '0.3.1')

    await checkForUpdates()

    expect(availableUpdate.value).toBeNull()
    expect(publishedUpdateVersion.value).toBeNull()
    expect(latestReadyVersion.value).toBeNull()
    expect(updateStage.value).toBe('manifest-error')
  })

  it('treats a target manifest version mismatch as a dedicated synchronization error', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockResolvedValue({ currentVersion: '0.3.0', version: '0.3.2' })
    mockRemote('0.3.1', '0.3.1')

    await checkForUpdates()

    expect(updateStage.value).toBe('version-mismatch')
    expect(updateError.value).toContain('尚未同步完成')
    expect(availableUpdate.value).toBeNull()
  })

  it('does not replace a downloaded task during a new check', async () => {
    updateStage.value = 'downloaded'
    availableUpdate.value = { currentVersion: '0.3.0', version: '0.3.1' }

    const result = await checkForUpdates()

    expect(result?.version).toBe('0.3.1')
    expect(getVersionMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(updateStage.value).toBe('downloaded')
  })

  it('keeps the downloaded package retryable after installation fails', async () => {
    updateStage.value = 'downloaded'
    invokeMock.mockRejectedValueOnce(new Error('installer failed'))

    await installDownloadedUpdate()

    expect(updateStage.value).toBe('install-error')
    expect(updateError.value).toContain('可重新安装')
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('implements SemVer prerelease ordering and rejects malformed versions', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0)
    expect(() => compareVersions('../latest', '1.0.0')).toThrow('无效版本号')
  })

  it('rejects catalogs from another repository or without immutable release fields', () => {
    expect(isReleaseManifest(remoteManifest())).toBe(true)
    expect(isReleaseManifest({ ...remoteManifest(), repository: 'attacker/book' })).toBe(false)
    const missingMinimum = remoteManifest()
    delete (missingMinimum.releases[0] as Partial<(typeof missingMinimum.releases)[number]>).minimumSupportedVersion
    expect(isReleaseManifest(missingMinimum)).toBe(false)
  })

  it('accepts legacy history entries without a direct upgrade baseline', () => {
    const catalog = remoteManifest()
    catalog.releases.push({
      version: '0.2.0',
      date: '2026-07-16',
      title: 'Legacy',
      channel: 'stable',
      databaseSchema: 3,
      published: true,
      releaseUrl: 'https://github.com/kengqin/book/releases/tag/v0.2.0',
      installerUrl: 'https://github.com/kengqin/book/releases/download/v0.2.0/NovelLibrary_0.2.0_x64-setup.exe',
      sha256: 'b'.repeat(64),
      sections: [{ title: 'Legacy', items: ['One'] }],
      upgradeNotes: []
    } as unknown as (typeof catalog.releases)[number])

    expect(isReleaseManifest(catalog)).toBe(true)
  })
})
