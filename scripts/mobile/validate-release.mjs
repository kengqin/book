import { readFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const repository = 'kengqin/book'
const appId = 'com.kengqin.novellibrary.mobile'

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? ''
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function validateManifest(manifest, version, tag, source) {
  requireValue(manifest?.schemaVersion === 1, `${source} schemaVersion 必须为 1`)
  requireValue(manifest.appId === appId, `${source} appId 必须为 ${appId}`)
  requireValue(manifest.latest === version, `${source} latest 必须为 ${version}`)
  requireValue(Array.isArray(manifest.releases) && manifest.releases.length > 0, `${source} 缺少 releases`)

  const release = manifest.releases[0]
  const apkName = `novel-library-mobile-${version}.apk`
  requireValue(release.version === version, `${source} 首条版本必须为 ${version}`)
  requireValue(release.channel === 'stable', `${source} 当前版本必须使用 stable 渠道`)
  requireValue(release.published === true, `${source} 当前版本 published 必须为 true`)
  requireValue(release.releaseUrl === `https://github.com/${repository}/releases/tag/${tag}`, `${source} releaseUrl 与 Tag 不一致`)
  requireValue(release.storeUrls?.androidApk === `https://github.com/${repository}/releases/download/${tag}/${apkName}`, `${source} Android APK 地址不正确`)
  requireValue(!release.storeUrls?.iosTestFlight && !release.storeUrls?.iosAppStore, `${source} 当前版本不得声明尚未发布的 iOS 渠道`)
  requireValue(/^[a-f0-9]{64}$/u.test(release.apkSha256), `${source} apkSha256 必须为 64 位十六进制`)
  return { release, apkName }
}

export function validateMobileRelease({ tag, mobilePackage, androidBuild, manifest, bundledManifest }) {
  const tagMatch = tag.match(/^mobile-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u)
  requireValue(tagMatch, '移动端 Tag 必须使用 mobile-v<semver> 格式')
  const version = tagMatch[1]
  requireValue(mobilePackage.version === version, `apps/mobile/package.json 版本必须为 ${version}`)

  const versionName = androidBuild.match(/\bversionName\s+["']([^"']+)["']/u)?.[1]
  const versionCode = Number(androidBuild.match(/\bversionCode\s+(\d+)/u)?.[1])
  requireValue(versionName === version, `Android versionName 必须为 ${version}`)
  requireValue(Number.isInteger(versionCode) && versionCode > 0, 'Android versionCode 必须为正整数')

  const primary = validateManifest(manifest, version, tag, 'releases/mobile-releases.json')
  validateManifest(bundledManifest, version, tag, 'apps/mobile/src/data/mobile-releases.json')
  return { version, versionCode, apkName: primary.apkName, title: primary.release.title }
}

async function main() {
  const [mobilePackage, androidBuild, manifest, bundledManifest] = await Promise.all([
    readFile(path.join(repoRoot, 'apps/mobile/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'apps/mobile/android/app/build.gradle'), 'utf8'),
    readFile(path.join(repoRoot, 'releases/mobile-releases.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'apps/mobile/src/data/mobile-releases.json'), 'utf8').then(JSON.parse)
  ])
  const tag = argument('tag') || `mobile-v${mobilePackage.version}`
  const result = validateMobileRelease({ tag, mobilePackage, androidBuild, manifest, bundledManifest })
  process.stdout.write(`Android release ${tag} validated (versionCode ${result.versionCode}, asset ${result.apkName}).\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
