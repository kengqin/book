import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  TARGET_MANIFEST_NAME,
  assertLegacyManifest,
  assertSignature,
  assertTargetManifest,
  findRelease,
  installerNameFromRelease,
  normalizeVersion,
  parseArguments,
  sha256Bytes
} from './release-utils.mjs'

async function fetchRequired(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options)
  if (!response.ok) throw new Error(`公开地址不可用（HTTP ${response.status}）：${url}`)
  return response
}

export async function verifyPublishedRelease({
  repository,
  tag,
  version,
  manifest,
  expectedState,
  verifyLatest = false,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = fetch
}) {
  const normalized = normalizeVersion(version || tag)
  const expectedTag = `v${normalized}`
  if (tag !== expectedTag) throw new Error(`Tag ${tag} 与版本 v${normalized} 不一致`)
  const release = findRelease(manifest, normalized)
  const installerName = installerNameFromRelease(release)
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) headers.Authorization = `Bearer ${token}`

  const releaseResponse = await fetchRequired(fetchImpl, `https://api.github.com/repos/${repository}/releases/tags/${tag}`, { headers })
  const githubRelease = await releaseResponse.json()
  if (githubRelease.draft) throw new Error('Release 仍为 Draft，不能执行公开验证')
  if (expectedState === 'prerelease' && !githubRelease.prerelease) throw new Error('Release 尚未处于公开预发布状态')
  if (expectedState === 'stable' && githubRelease.prerelease) throw new Error('Release 仍为 Prerelease')

  const assetNames = new Set((githubRelease.assets || []).map((asset) => asset.name))
  const requiredAssets = [installerName, `${installerName}.sig`, `${installerName}.sha256`, TARGET_MANIFEST_NAME, 'SHA256SUMS.txt']
  for (const asset of requiredAssets) {
    if (!assetNames.has(asset)) throw new Error(`Release 缺少资产：${asset}`)
  }

  const base = `https://github.com/${repository}/releases/download/${tag}`
  const [targetResponse, signatureResponse, checksumResponse, sumsResponse, installerResponse] = await Promise.all([
    fetchRequired(fetchImpl, `${base}/${TARGET_MANIFEST_NAME}`),
    fetchRequired(fetchImpl, `${base}/${installerName}.sig`),
    fetchRequired(fetchImpl, `${base}/${installerName}.sha256`),
    fetchRequired(fetchImpl, `${base}/SHA256SUMS.txt`),
    fetchRequired(fetchImpl, `${base}/${installerName}`)
  ])
  const [target, signature, checksumText, sumsText, installerBytes] = await Promise.all([
    targetResponse.json(),
    signatureResponse.text(),
    checksumResponse.text(),
    sumsResponse.text(),
    installerResponse.arrayBuffer()
  ])
  const normalizedSignature = assertSignature(signature)
  assertTargetManifest(target, { repository, version: normalized, installerName, signature: normalizedSignature })
  const actualHash = sha256Bytes(Buffer.from(installerBytes))
  if (actualHash !== release.sha256.toLowerCase()) throw new Error('公开安装包 SHA256 与版本目录不一致')
  if (!checksumText.toLowerCase().includes(`${actualHash}  ${installerName.toLowerCase()}`)) {
    throw new Error('安装包 .sha256 文件内容不一致')
  }
  if (!sumsText.toLowerCase().includes(`${actualHash}  ${installerName.toLowerCase()}`)) {
    throw new Error('SHA256SUMS.txt 内容与公开安装包不一致')
  }

  if (verifyLatest) {
    const latestResponse = await fetchRequired(fetchImpl, `https://github.com/${repository}/releases/latest/download/latest.json`)
    const latest = await latestResponse.json()
    assertLegacyManifest(latest, { repository, version: normalized, installerName, signature: normalizedSignature })
  }
  return { version: normalized, installerName, sha256: actualHash }
}

async function main() {
  const args = parseArguments()
  for (const required of ['repository', 'tag', 'manifest', 'expected-state']) {
    if (!args[required]) throw new Error(`缺少 --${required}`)
  }
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'))
  const result = await verifyPublishedRelease({
    repository: args.repository,
    tag: args.tag,
    version: args.version || args.tag,
    manifest,
    expectedState: args['expected-state'],
    verifyLatest: args['verify-latest'] === 'true'
  })
  console.log(`Published release v${result.version} verified (${result.sha256}).`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
