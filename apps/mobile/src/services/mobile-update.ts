import { getAvailableMobileUpdate, isMobileUpdateManifest, type AvailableMobileUpdate, type MobileUpdatePlatform, type MobileUpdateManifest, type UpdateChannel } from '@novel-library/reader-protocol'
import localManifest from '../data/mobile-releases.json'
import { Capacitor } from '@capacitor/core'
import { ApkInstaller } from '../native/apk-installer'

export const MOBILE_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/kengqin/book/main/releases/mobile-releases.json'
export const MOBILE_APP_ID = 'com.kengqin.novellibrary.mobile'

export interface MobileUpdateCheckOptions {
  currentVersion: string
  platform: MobileUpdatePlatform
  channel?: UpdateChannel
  manifestUrl?: string
  fetcher?: typeof fetch
}

export async function checkMobileUpdate(options: MobileUpdateCheckOptions): Promise<AvailableMobileUpdate | null> {
  const fetcher = options.fetcher ?? fetch
  let payload: unknown
  if (import.meta.env.DEV && options.manifestUrl === undefined && fetcher === fetch) {
    payload = localManifest
  } else try {
    const response = await fetcher(options.manifestUrl ?? MOBILE_UPDATE_MANIFEST_URL, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}`)
    payload = await response.json()
  } catch (cause) {
    if (options.manifestUrl === undefined && fetcher === fetch) payload = localManifest
    else throw cause
  }
  if (!isMobileUpdateManifest(payload, MOBILE_APP_ID)) throw new Error('移动端版本清单格式无效')
  return getAvailableMobileUpdate(options.currentVersion, payload as MobileUpdateManifest, options.platform, options.channel ?? 'stable')
}

export function openMobileStore(update: AvailableMobileUpdate) {
  if (update.platform === 'android' && update.release.storeUrls.androidApk && Capacitor.getPlatform() === 'android') {
    return ApkInstaller.install({ url: update.storeUrl, sha256: update.release.apkSha256 })
  }
  window.open(update.storeUrl, '_blank', 'noopener,noreferrer')
}
