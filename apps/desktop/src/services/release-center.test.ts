import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getVersionMock, invokeMock, relaunchMock } = vi.hoisted(() => ({
  getVersionMock: vi.fn(),
  invokeMock: vi.fn(),
  relaunchMock: vi.fn()
}))

vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchMock }))

import {
  availableUpdate,
  checkForUpdates,
  compareVersions,
  installDownloadedUpdate,
  isReleaseManifest,
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

function mockRemote(latest = '0.3.1') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => remoteManifest(latest)
  }))
}

describe('release center update consistency', () => {
  beforeEach(() => {
    getVersionMock.mockReset()
    invokeMock.mockReset()
    relaunchMock.mockReset()
    availableUpdate.value = null
    publishedUpdateVersion.value = null
    Object.assign(updateTask, {
      stage: 'idle', version: '', progress: 0, message: '', error: '', downloadedBytes: 0, totalBytes: 0, retryCount: 0
    })
  })

  it('does not report latest when the release catalog has a newer version but its target manifest is not ready', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockResolvedValue(null)
    mockRemote()

    await checkForUpdates()

    expect(invokeMock).toHaveBeenCalledWith('check_application_update', { expectedVersion: '0.3.1' })
    expect(availableUpdate.value).toBeNull()
    expect(publishedUpdateVersion.value).toBe('0.3.1')
    expect(updateStage.value).toBe('published-but-not-ready')
    expect(updateError.value).toContain('安装包正在准备')
    expect(updateMessage.value).not.toContain('已是最新')
  })

  it('treats a target manifest version mismatch as a dedicated synchronization error', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockResolvedValue({ currentVersion: '0.3.0', version: '0.3.2' })
    mockRemote()

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
})
