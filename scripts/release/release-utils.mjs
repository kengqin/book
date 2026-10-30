import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export const TARGET_KEY = 'windows-x86_64-nsis'
export const TARGET_MANIFEST_NAME = `latest-${TARGET_KEY}.json`

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseArguments(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map((entry) => {
    const match = entry.match(/^--([^=]+)=(.*)$/s)
    if (!match) throw new Error(`参数格式无效：${entry}`)
    return [match[1], match[2]]
  }))
}

export function normalizeVersion(value) {
  const version = String(value || '').replace(/^v/, '')
  if (!SEMVER_PATTERN.test(version)) throw new Error(`SemVer 格式无效：${value}`)
  return version
}

export function compareSemver(left, right) {
  const parse = (value) => {
    const match = normalizeVersion(value).match(SEMVER_PATTERN)
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4]?.split('.') || []
    }
  }
  const a = parse(left)
  const b = parse(right)
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
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

export function installerDownloadUrl(repository, version, installerName) {
  return `https://github.com/${repository}/releases/download/v${normalizeVersion(version)}/${installerName}`
}

// Old clients pin installer downloads to the repository name used when installed.
export function updaterDownloadUrl(repository, version, installerName) {
  const compatibleRepository = repository === 'kengqin/library-manage' ? 'kengqin/book' : repository
  return installerDownloadUrl(compatibleRepository, version, installerName)
}

export function assertUpdaterDownloadUrl(url, repository, version, installerName) {
  const canonical = installerDownloadUrl(repository, version, installerName)
  const compatible = updaterDownloadUrl(repository, version, installerName)
  if (url !== canonical && url !== compatible) throw new Error(`更新安装包 URL 必须是官方固定版本地址：${compatible}`)
}

export function validateReleaseHistory(current, baseline) {
  const comparableRelease = release => {
    const copy = { ...release }
    for (const key of ['minimumSupportedVersion', 'requiresBackup', 'upgradeNotes']) delete copy[key]
    return copy
  }
  const currentByVersion = new Map(current.releases.map((release) => [release.version, release]))
  for (const previous of baseline.releases) {
    const retained = currentByVersion.get(previous.version)
    if (!retained) throw new Error(`历史版本 v${previous.version} 被删除，版本记录只能新增`)
    const previousComparable = comparableRelease(previous)
    const retainedComparable = comparableRelease(retained)
    // A repository rename only changes the URL prefix, never the tag or asset name.
    if (baseline.repository !== current.repository) {
      const oldPrefix = `https://github.com/${baseline.repository}/releases/`
      const newPrefix = `https://github.com/${current.repository}/releases/`
      for (const key of ['releaseUrl', 'installerUrl']) {
        if (typeof previousComparable[key] === 'string' && previousComparable[key].startsWith(oldPrefix)) {
          previousComparable[key] = newPrefix + previousComparable[key].slice(oldPrefix.length)
        }
      }
    }
    const canRetireFailedLatest = previous.version === baseline.releases[0]?.version && previous.published && !retained.published
    if (canRetireFailedLatest) previousComparable.published = false
    if (JSON.stringify(retainedComparable) !== JSON.stringify(previousComparable)) {
      throw new Error(`历史版本 v${previous.version} 被修改，已发布记录不可覆盖`)
    }
  }
}

export function assertOfficialDownloadUrl(url, repository, version, installerName) {
  const expected = installerDownloadUrl(repository, version, installerName)
  if (url !== expected) throw new Error(`安装包 URL 必须是版本固定地址：${expected}`)
}

export function notesFromRelease(release) {
  const sections = release.sections.map((section) => `${section.title}：${section.items.join('；')}`)
  return [release.title, '', ...sections].join('\n').trim()
}

export function findRelease(manifest, version) {
  const normalized = normalizeVersion(version)
  const release = manifest.releases.find((entry) => entry.version === normalized)
  if (!release) throw new Error(`版本目录中不存在 v${normalized}`)
  return release
}

export async function sha256File(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function assertSignature(signature) {
  const value = String(signature || '').trim()
  if (value.length < 40 || /\s/.test(value)) throw new Error('Updater 签名格式无效或为空')
  return value
}

export function assertTargetManifest(manifest, { repository, version, installerName, signature }) {
  const expectedVersion = normalizeVersion(version)
  if (manifest.version !== expectedVersion) throw new Error('目标 Manifest 版本与 Tag 不一致')
  if (!manifest.notes || typeof manifest.notes !== 'string') throw new Error('目标 Manifest 缺少更新说明')
  if (!manifest.pub_date || Number.isNaN(Date.parse(manifest.pub_date))) throw new Error('目标 Manifest 发布时间无效')
  assertUpdaterDownloadUrl(manifest.url, repository, expectedVersion, installerName)
  if (manifest.signature !== assertSignature(signature)) throw new Error('目标 Manifest 签名与 .sig 文件不一致')
}

export function assertLegacyManifest(manifest, { repository, version, installerName, signature }) {
  const expectedVersion = normalizeVersion(version)
  if (manifest.version !== expectedVersion) throw new Error('latest.json 版本与 Tag 不一致')
  for (const key of ['windows-x86_64', TARGET_KEY]) {
    const platform = manifest.platforms?.[key]
    if (!platform) throw new Error(`latest.json 缺少平台 ${key}`)
    assertUpdaterDownloadUrl(platform.url, repository, expectedVersion, installerName)
    if (platform.signature !== assertSignature(signature)) throw new Error(`${key} 签名与 .sig 文件不一致`)
  }
}

export function installerNameFromRelease(release) {
  let parsed
  try {
    parsed = new URL(release.installerUrl)
  } catch {
    throw new Error(`v${release.version} installerUrl 无效`)
  }
  return basename(parsed.pathname)
}
