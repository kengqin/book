import { readFile } from 'node:fs/promises'
import process from 'node:process'

const root = new URL('../', import.meta.url)

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

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

const expected = desktopPackage.version
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

if (!releaseManifest.releases.some((release) => release.version === expected)) {
  throw new Error(`版本清单缺少 ${expected}`)
}

if (!changelog.includes(`## [${expected}]`)) {
  throw new Error(`CHANGELOG.md 缺少 ${expected}`)
}

const tagArgument = process.argv.find((argument) => argument.startsWith('--tag='))
if (tagArgument && tagArgument.slice(6).replace(/^v/, '') !== expected) {
  throw new Error(`Tag ${tagArgument.slice(6)} 与应用版本 ${expected} 不一致`)
}

console.log(`Release v${expected} validation passed.`)
