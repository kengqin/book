import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { compareSemver, installerNameFromRelease, normalizeVersion, parseArguments } from './release/release-utils.mjs'

const root = new URL('../', import.meta.url)

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

function validateReleaseEntry(release, manifest) {
  const prefix = `v${release.version}`
  normalizeVersion(release.version)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date) || Number.isNaN(Date.parse(`${release.date}T00:00:00Z`))) {
    throw new Error(`${prefix} 发布日期无效`)
  }
  if (!['stable', 'preview'].includes(release.channel)) throw new Error(`${prefix} channel 无效`)
  if (!Number.isInteger(release.databaseSchema) || release.databaseSchema < 1) throw new Error(`${prefix} databaseSchema 无效`)
  if (typeof release.published !== 'boolean') throw new Error(`${prefix} 缺少 published`)
  const isLatestRelease = release.version === manifest.latest
  if (release.minimumSupportedVersion !== undefined) {
    normalizeVersion(release.minimumSupportedVersion)
    if (compareSemver(release.minimumSupportedVersion, release.version) > 0) {
      throw new Error(`${prefix} minimumSupportedVersion 不能高于当前版本`)
    }
  } else if (isLatestRelease) {
    throw new Error(`${prefix} 缺少 minimumSupportedVersion`)
  }
  if (release.requiresBackup !== undefined && typeof release.requiresBackup !== 'boolean') {
    throw new Error(`${prefix} requiresBackup 无效`)
  }
  if (isLatestRelease && release.requiresBackup === undefined) throw new Error(`${prefix} 缺少 requiresBackup`)
  if (!Array.isArray(release.sections) || release.sections.length === 0 || release.sections.some((section) => {
    return !section?.title || !Array.isArray(section.items) || section.items.length === 0 || section.items.some((item) => typeof item !== 'string' || !item.trim())
  })) throw new Error(`${prefix} 缺少有效的更新章节`)
  if (release.upgradeNotes !== undefined && !Array.isArray(release.upgradeNotes)) {
    throw new Error(`${prefix} upgradeNotes 必须是数组`)
  }
  if (isLatestRelease && release.upgradeNotes === undefined) throw new Error(`${prefix} 缺少 upgradeNotes`)

  if (release.published) {
    const expectedReleaseUrl = `https://github.com/${manifest.repository}/releases/tag/v${release.version}`
    if (release.releaseUrl !== expectedReleaseUrl) throw new Error(`${prefix} Release URL 必须是 ${expectedReleaseUrl}`)
    const installerName = installerNameFromRelease(release)
    const expectedInstallerPrefix = `https://github.com/${manifest.repository}/releases/download/v${release.version}/`
    if (!release.installerUrl.startsWith(expectedInstallerPrefix) || !installerName.endsWith('-setup.exe')) {
      throw new Error(`${prefix} 安装包必须使用固定 Tag 下的 NSIS setup.exe`)
    }
    if (release.sha256 !== undefined && release.sha256 !== '' && !/^[a-f0-9]{64}$/i.test(release.sha256)) {
      throw new Error(`${prefix} SHA256 格式无效`)
    }
  }
}

function validateHistory(current, baseline) {
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
    const canRetireFailedLatest = previous.version === baseline.releases[0]?.version && previous.published && !retained.published
    if (canRetireFailedLatest) previousComparable.published = false
    if (JSON.stringify(retainedComparable) !== JSON.stringify(previousComparable)) {
      throw new Error(`历史版本 v${previous.version} 被修改，已发布记录不可覆盖`)
    }
  }
}

const args = parseArguments()
const [rootPackage, desktopPackage, tauriConfig, releaseManifest, cargoToml, changelog] = await Promise.all([
  readJson('package.json'),
  readJson('apps/desktop/package.json'),
  readJson('apps/desktop/src-tauri/tauri.conf.json'),
  readJson('releases/releases.json'),
  readFile(new URL('apps/desktop/src-tauri/Cargo.toml', root), 'utf8'),
  readFile(new URL('CHANGELOG.md', root), 'utf8')
])

const cargoPackage = cargoToml.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)
if (!cargoPackage) throw new Error('无法读取 Cargo.toml 的 package.version')

const expected = normalizeVersion(desktopPackage.version)
const versions = {
  'package.json': rootPackage.version,
  'apps/desktop/package.json': desktopPackage.version,
  'apps/desktop/src-tauri/Cargo.toml': cargoPackage[1],
  'apps/desktop/src-tauri/tauri.conf.json': tauriConfig.version,
  'releases/releases.json': releaseManifest.latest
}
const mismatches = Object.entries(versions).filter(([, version]) => version !== expected)
if (mismatches.length > 0) {
  throw new Error(`版本号不一致：${mismatches.map(([file, version]) => `${file}=${version}`).join(', ')}`)
}
if (releaseManifest.schemaVersion !== 1) throw new Error('版本目录 schemaVersion 必须为 1')
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(releaseManifest.repository || '')) throw new Error('版本目录 repository 无效')
if (!Array.isArray(releaseManifest.releases) || releaseManifest.releases.length === 0) throw new Error('版本目录不能为空')
if (releaseManifest.releases[0]?.version !== expected) throw new Error(`最新版本 ${expected} 必须新增在版本目录首位`)

const releaseVersions = releaseManifest.releases.map((release) => release.version)
if (new Set(releaseVersions).size !== releaseVersions.length) throw new Error('版本目录存在重复版本，发布记录只能新增不能覆盖')
for (const release of releaseManifest.releases) validateReleaseEntry(release, releaseManifest)
for (let index = 1; index < releaseManifest.releases.length; index += 1) {
  const newer = releaseManifest.releases[index - 1]
  const older = releaseManifest.releases[index]
  if (compareSemver(newer.version, older.version) <= 0) throw new Error('版本目录必须按 SemVer 从新到旧排列')
  if (newer.databaseSchema < older.databaseSchema) throw new Error(`数据库 Schema 从 v${older.version} 到 v${newer.version} 出现降级`)
}

const missingChangelogVersions = releaseVersions.filter((version) => !changelog.includes(`## [${version}]`))
if (missingChangelogVersions.length > 0) throw new Error(`CHANGELOG.md 缺少版本：${missingChangelogVersions.join(', ')}`)
if (args.tag && normalizeVersion(args.tag) !== expected) throw new Error(`Tag ${args.tag} 与应用版本 ${expected} 不一致`)

if (args['baseline-ref']) {
  let baselineText
  try {
    baselineText = execFileSync('git', ['show', `${args['baseline-ref']}:releases/releases.json`], { cwd: new URL('.', root), encoding: 'utf8' })
  } catch {
    throw new Error(`无法读取历史基线 ${args['baseline-ref']}:releases/releases.json`)
  }
  validateHistory(releaseManifest, JSON.parse(baselineText))
}

console.log(`Release v${expected} validation passed (${releaseManifest.releases.length} immutable records).`)
