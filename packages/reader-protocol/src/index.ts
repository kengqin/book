export const READER_PROTOCOL_VERSION = 1

export interface BridgeManifest {
  protocolVersion: number
  appVersion: string
  port: number
  sessionId: string
  capabilities: string[]
}

export interface BridgeBook {
  id: string
  title: string
  author: string
  description: string
  sourceName: string
  sourceFormat: 'txt' | 'epub'
  chapterCount: number
  totalWords: number
  currentChapter: number
  progress: number
  chapterProgress: number
  updatedAt: number
  lastReadAt: number
}

export interface BridgeChapterSummary {
  id: string
  bookId: string
  number: number
  originalLabel: string
  title: string
  volume: string
  kind: string
  wordCount: number
  contentFormat: 'text' | 'html'
}

export interface BridgeChapter extends BridgeChapterSummary {
  content: string
  contentText: string
}

export interface ProgressUpdate {
  bookId: string
  chapterNumber: number
  chapterProgress: number
  anchorOffset?: number
  paragraphIndex?: number
  lineIndex?: number
  updatedAt?: number
}

export interface ImportRequest {
  path: string
  existingId?: string
}

export interface OpenRequest {
  bookId: string
  chapterNumber?: number
}

export type BridgeEvent =
  | { type: 'book-updated'; bookId: string }
  | { type: 'progress-updated'; update: ProgressUpdate }
  | { type: 'import-requested'; request: ImportRequest }
  | { type: 'open-requested'; request: OpenRequest }

export function bridgeUrl(port: number, path: string) {
  return `http://127.0.0.1:${port}${path}`
}

export type MobileUpdatePlatform = 'android' | 'ios'
export type UpdateChannel = 'stable' | 'preview'

export interface MobileStoreLinks {
  android?: string
  androidApk?: string
  ios?: string
  iosTestFlight?: string
}

export interface MobileReleaseSection {
  title: string
  items: string[]
}

export interface MobileReleaseEntry {
  version: string
  date: string
  title: string
  channel: UpdateChannel
  published: boolean
  minimumSupportedVersion?: string
  releaseUrl: string
  storeUrls: MobileStoreLinks
  apkSha256?: string
  contentManifestUrl?: string
  sections: MobileReleaseSection[]
}

export interface MobileUpdateManifest {
  schemaVersion: 1
  appId: string
  latest: string
  releases: MobileReleaseEntry[]
}

export interface AvailableMobileUpdate {
  currentVersion: string
  version: string
  platform: MobileUpdatePlatform
  release: MobileReleaseEntry
  storeUrl: string
}

const mobileSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function parseProtocolVersion(value: string) {
  const normalized = value.replace(/^v/u, '')
  const match = normalized.match(mobileSemverPattern)
  if (!match) throw new Error(`无效版本号：${value}`)
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] }
}

export function compareProtocolVersions(left: string, right: string) {
  const a = parseProtocolVersion(left)
  const b = parseProtocolVersion(right)
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
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

function isHttpsUrl(value: unknown, hosts: string[]) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && hosts.includes(url.hostname)
  } catch {
    return false
  }
}

function isValidStoreLinks(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const links = value as MobileStoreLinks
  return (links.android === undefined || isHttpsUrl(links.android, ['play.google.com', 'market.android.com']))
    && (links.androidApk === undefined || isHttpsUrl(links.androidApk, ['github.com', 'objects.githubusercontent.com']))
    && (links.ios === undefined || isHttpsUrl(links.ios, ['apps.apple.com', 'itunes.apple.com']))
    && (links.iosTestFlight === undefined || isHttpsUrl(links.iosTestFlight, ['testflight.apple.com']))
    && Boolean(links.android || links.androidApk || links.ios || links.iosTestFlight)
}

export function isMobileUpdateManifest(value: unknown, expectedAppId?: string): value is MobileUpdateManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<MobileUpdateManifest>
  if (manifest.schemaVersion !== 1 || typeof manifest.appId !== 'string' || !manifest.appId.trim() || (expectedAppId && manifest.appId !== expectedAppId)) return false
  if (typeof manifest.latest !== 'string' || !Array.isArray(manifest.releases)) return false
  try {
    parseProtocolVersion(manifest.latest)
  } catch {
    return false
  }
  const versions = new Set<string>()
  for (const release of manifest.releases) {
    if (!release || typeof release !== 'object') return false
    const entry = release as Partial<MobileReleaseEntry>
    try {
      if (typeof entry.version !== 'string') return false
      parseProtocolVersion(entry.version)
      if (entry.minimumSupportedVersion !== undefined) {
        if (typeof entry.minimumSupportedVersion !== 'string') return false
        parseProtocolVersion(entry.minimumSupportedVersion)
      }
    } catch {
      return false
    }
    if (versions.has(entry.version) || typeof entry.date !== 'string' || typeof entry.title !== 'string') return false
    if (entry.channel !== 'stable' && entry.channel !== 'preview') return false
    if (typeof entry.published !== 'boolean' || !isHttpsUrl(entry.releaseUrl, ['github.com'])) return false
    if (entry.apkSha256 !== undefined && (typeof entry.apkSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(entry.apkSha256))) return false
    if (!isValidStoreLinks(entry.storeUrls) || !Array.isArray(entry.sections)) return false
    if (entry.contentManifestUrl !== undefined && !isHttpsUrl(entry.contentManifestUrl, ['raw.githubusercontent.com', 'github.com'])) return false
    for (const section of entry.sections) {
      if (!section || typeof section !== 'object' || typeof section.title !== 'string' || !Array.isArray(section.items) || section.items.some(item => typeof item !== 'string')) return false
    }
    versions.add(entry.version)
  }
  return manifest.releases[0]?.version === manifest.latest && manifest.releases[0]?.published === true
}

export function getAvailableMobileUpdate(
  currentVersion: string,
  manifest: MobileUpdateManifest,
  platform: MobileUpdatePlatform,
  channel: UpdateChannel = 'stable'
): AvailableMobileUpdate | null {
  const updateUrl = (release: MobileReleaseEntry) => platform === 'android'
    ? release.storeUrls.android ?? release.storeUrls.androidApk
    : release.storeUrls.ios ?? release.storeUrls.iosTestFlight
  const release = manifest.releases.find(item => item.published && item.channel === channel && updateUrl(item) && compareProtocolVersions(item.version, currentVersion) > 0)
  const storeUrl = release ? updateUrl(release) : undefined
  if (!release || !storeUrl) return null
  return { currentVersion, version: release.version, platform, release, storeUrl }
}
