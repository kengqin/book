import { describe, expect, it } from 'vitest'
import { compareProtocolVersions, getAvailableMobileUpdate, isMobileUpdateManifest } from './index'

function manifest() {
  return {
    schemaVersion: 1 as const,
    appId: 'com.kengqin.novellibrary.mobile',
    latest: '1.2.0',
    releases: [{
      version: '1.2.0',
      date: '2026-07-19',
      title: '移动端首版',
      channel: 'stable' as const,
      published: true,
      releaseUrl: 'https://github.com/kengqin/book/releases/tag/v1.2.0',
      storeUrls: {
        android: 'https://play.google.com/store/apps/details?id=com.kengqin.novellibrary.mobile',
        ios: 'https://apps.apple.com/app/id123456789'
      },
      apkSha256: 'a'.repeat(64),
      sections: [{ title: '新增', items: ['移动端阅读器'] }]
    }]
  }
}

describe('mobile update protocol', () => {
  it('orders stable and prerelease versions correctly', () => {
    expect(compareProtocolVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareProtocolVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0)
    expect(() => compareProtocolVersions('../latest', '1.0.0')).toThrow('无效版本号')
  })

  it('validates the app id, store hosts and release shape', () => {
    expect(isMobileUpdateManifest(manifest(), 'com.kengqin.novellibrary.mobile')).toBe(true)
    expect(isMobileUpdateManifest(manifest(), 'com.other.app')).toBe(false)
    expect(isMobileUpdateManifest({ ...manifest(), releases: [{ ...manifest().releases[0], storeUrls: { ios: 'https://example.com/update' } }] })).toBe(false)
    expect(isMobileUpdateManifest({ ...manifest(), releases: [{ ...manifest().releases[0], releaseUrl: 'http://github.com/kengqin/book/releases/tag/v1.2.0' }] })).toBe(false)
  })

  it('returns a platform-specific update and ignores older releases', () => {
    const result = getAvailableMobileUpdate('1.1.0', manifest(), 'ios')
    expect(result?.version).toBe('1.2.0')
    expect(result?.storeUrl).toContain('apps.apple.com')
    expect(getAvailableMobileUpdate('1.2.0', manifest(), 'android')).toBeNull()
  })

  it('does not offer a stable update when only a preview release is newer', () => {
    const data = manifest()
    data.releases[0].channel = 'preview'
    expect(getAvailableMobileUpdate('1.1.0', data, 'android')).toBeNull()
    expect(getAvailableMobileUpdate('1.1.0', data, 'android', 'preview')?.version).toBe('1.2.0')
  })

  it('supports direct Android APK and TestFlight fallback links', () => {
    const data = manifest()
    data.releases[0].storeUrls = {
      androidApk: 'https://github.com/kengqin/book/releases/download/v1.2.0/novel-library.apk',
      iosTestFlight: 'https://testflight.apple.com/join/example'
    }
    data.releases[0].apkSha256 = 'b'.repeat(64)
    expect(isMobileUpdateManifest(data)).toBe(true)
    expect(getAvailableMobileUpdate('1.1.0', data, 'android')?.storeUrl).toContain('.apk')
    expect(getAvailableMobileUpdate('1.1.0', data, 'ios')?.storeUrl).toContain('testflight.apple.com')
  })
})
