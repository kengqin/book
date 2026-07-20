import { describe, expect, it, vi } from 'vitest'
import { checkMobileUpdate } from './mobile-update'

function validManifest() {
  return {
    schemaVersion: 1,
    appId: 'com.kengqin.novellibrary.mobile',
    latest: '0.2.0',
    releases: [{
      version: '0.2.0',
      date: '2026-07-19',
      title: '测试更新',
      channel: 'stable',
      published: true,
      releaseUrl: 'https://github.com/kengqin/book/releases/tag/v0.2.0',
      storeUrls: { android: 'https://play.google.com/store/apps/details?id=com.kengqin.novellibrary.mobile' },
      sections: []
    }]
  }
}

describe('mobile update service', () => {
  it('fetches and filters an Android store update', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => validManifest() })
    const result = await checkMobileUpdate({ currentVersion: '0.1.0', platform: 'android', manifestUrl: 'https://updates.test/mobile.json', fetcher })
    expect(fetcher).toHaveBeenCalledWith('https://updates.test/mobile.json', { cache: 'no-cache' })
    expect(result?.version).toBe('0.2.0')
  })

  it('rejects HTTP failures and malformed manifests', async () => {
    const failedFetcher = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    await expect(checkMobileUpdate({ currentVersion: '0.1.0', platform: 'ios', fetcher: failedFetcher })).rejects.toThrow('HTTP 503')
    const malformedFetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1 }) })
    await expect(checkMobileUpdate({ currentVersion: '0.1.0', platform: 'ios', fetcher: malformedFetcher })).rejects.toThrow('版本清单格式无效')
  })
})
