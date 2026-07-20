import { describe, expect, it } from 'vitest'
import { validateMobileRelease } from './validate-release.mjs'

function fixture() {
  const version = '0.1.0'
  const tag = `mobile-v${version}`
  const manifest = {
    schemaVersion: 1,
    appId: 'com.kengqin.novellibrary.mobile',
    latest: version,
    releases: [{
      version,
      title: '首版',
      channel: 'stable',
      published: true,
      releaseUrl: `https://github.com/kengqin/book/releases/tag/${tag}`,
      storeUrls: {
        androidApk: `https://github.com/kengqin/book/releases/download/${tag}/novel-library-mobile-${version}.apk`
      },
      apkSha256: '0'.repeat(64)
    }]
  }
  return {
    tag,
    mobilePackage: { version },
    androidBuild: 'versionCode 1\nversionName "0.1.0"',
    manifest,
    bundledManifest: structuredClone(manifest)
  }
}

describe('Android release validation', () => {
  it('accepts an independent mobile tag and signed APK URL', () => {
    expect(validateMobileRelease(fixture())).toMatchObject({
      version: '0.1.0',
      versionCode: 1,
      apkName: 'novel-library-mobile-0.1.0.apk'
    })
  })

  it('rejects desktop-style tags and unpublished iOS placeholders', () => {
    const invalidTag = fixture()
    invalidTag.tag = 'v0.1.0'
    expect(() => validateMobileRelease(invalidTag)).toThrow(/mobile-v/u)

    const invalidIos = fixture()
    invalidIos.manifest.releases[0].storeUrls.iosTestFlight = 'https://testflight.apple.com/join/example'
    expect(() => validateMobileRelease(invalidIos)).toThrow(/iOS/u)
  })
})
