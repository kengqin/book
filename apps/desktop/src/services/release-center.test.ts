import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getVersionMock, invokeMock } = vi.hoisted(() => ({
  getVersionMock: vi.fn(),
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: getVersionMock
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn()
}))

import {
  availableUpdate,
  checkForUpdates,
  publishedUpdateVersion,
  updateError,
  updateMessage,
  updateStage
} from './release-center'

describe('release center update consistency', () => {
  beforeEach(() => {
    getVersionMock.mockReset()
    invokeMock.mockReset()
    availableUpdate.value = null
    publishedUpdateVersion.value = null
    updateError.value = ''
    updateMessage.value = ''
    updateStage.value = 'idle'
  })

  it('does not report latest when the release manifest already has a newer version', async () => {
    getVersionMock.mockResolvedValue('0.3.0')
    invokeMock.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        repository: 'kengqin/book',
        latest: '0.3.1',
        releases: []
      })
    }))

    await checkForUpdates()

    expect(invokeMock).toHaveBeenCalledWith('check_application_update', {
      expectedVersion: '0.3.1'
    })
    expect(availableUpdate.value).toBeNull()
    expect(publishedUpdateVersion.value).toBe('0.3.1')
    expect(updateMessage.value).toContain('已发布')
    expect(updateMessage.value).not.toContain('已是最新')
  })
})
