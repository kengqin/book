import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { normalizeVersion, parseArguments } from './release-utils.mjs'

export const IDE_PLUGIN_BUILD_INPUTS = Object.freeze([
  'apps/local-runtime/',
  'packages/reader-protocol/',
  'plugins/',
  'apps/desktop/src-tauri/resources/ide-plugins/manifest.json',
  'scripts/package-visual-studio-plugin.ps1',
  'scripts/stage-ide-plugin-runtime.ps1'
])

const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/i

function normalizedPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

export function isIdePluginBuildInput(path) {
  const candidate = normalizedPath(path)
  return IDE_PLUGIN_BUILD_INPUTS.some(input => input.endsWith('/')
    ? candidate.startsWith(input)
    : candidate === input)
}

export function assessIdePluginReuse({ currentTag, previousRelease, expectedFiles, changedFiles }) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(currentTag || '')) {
    return { reusable: false, reason: 'current release tag is invalid' }
  }
  const previousTag = previousRelease?.tag_name
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(previousTag || '') || previousTag === currentTag) {
    return { reusable: false, reason: 'a distinct previous stable release is unavailable' }
  }
  if (previousRelease.draft || previousRelease.prerelease) {
    return { reusable: false, reason: `${previousTag} is not a stable release` }
  }

  const files = Array.from(expectedFiles || [])
  if (files.length !== 3 || new Set(files).size !== files.length || files.some(file => file !== basename(file) || !/\.(?:vsix|zip)$/i.test(file))) {
    return { reusable: false, reason: 'the IDE plugin manifest does not contain three unique package files' }
  }

  const relevantChanges = Array.from(changedFiles || []).map(normalizedPath).filter(isIdePluginBuildInput)
  if (relevantChanges.length > 0) {
    return { reusable: false, reason: `IDE plugin build inputs changed: ${relevantChanges.join(', ')}`, changedFiles: relevantChanges }
  }

  const assets = Array.from(previousRelease.assets || [])
  const reusableAssets = []
  for (const file of files) {
    const matches = assets.filter(asset => asset?.name === file)
    if (matches.length !== 1) return { reusable: false, reason: `${previousTag} does not contain exactly one ${file} asset` }
    const asset = matches[0]
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      return { reusable: false, reason: `${file} has an invalid asset size` }
    }
    const digest = String(asset.digest || '').match(SHA256_DIGEST)
    if (!digest) return { reusable: false, reason: `${file} does not have a trusted SHA-256 digest` }
    const url = asset.url || asset.browser_download_url
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return { reusable: false, reason: `${file} does not have a secure download URL` }
    }
    reusableAssets.push({ name: file, size: asset.size, sha256: digest[1].toLowerCase(), url })
  }

  return { reusable: true, reason: `IDE plugin build inputs are unchanged from ${previousTag}`, previousTag, assets: reusableAssets }
}

export async function downloadAndVerifyIdePluginAssets({ assets, outputDirectory, token = '', fetchImpl = fetch }) {
  await mkdir(outputDirectory, { recursive: true })
  const stagingDirectory = await mkdtemp(join(outputDirectory, '.reuse-'))
  try {
    for (const asset of assets) {
      const headers = { Accept: 'application/octet-stream', 'User-Agent': 'NovelLibrary-Release' }
      if (token) headers.Authorization = `Bearer ${token}`
      const response = await fetchImpl(asset.url, { headers, redirect: 'follow' })
      if (!response.ok) throw new Error(`${asset.name} download failed with HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length !== asset.size) throw new Error(`${asset.name} size does not match the GitHub asset metadata`)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== asset.sha256) throw new Error(`${asset.name} SHA-256 does not match the GitHub asset digest`)
      await writeFile(join(stagingDirectory, basename(asset.name)), bytes)
    }
    for (const asset of assets) {
      await rename(join(stagingDirectory, basename(asset.name)), join(outputDirectory, basename(asset.name)))
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

function ensureTag(tag) {
  try {
    git(['rev-parse', '--verify', `refs/tags/${tag}`])
  } catch {
    git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
  }
}

function changedFilesBetween(previousTag, currentTag) {
  const output = git(['diff', '--name-only', previousTag, currentTag, '--'])
  return output ? output.split(/\r?\n/u) : []
}

async function githubJson(url, token, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'NovelLibrary-Release' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl(url, { headers })
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`)
  return response.json()
}

async function writeOutput(values) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  await appendFile(output, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/gu, ' ')}`).join('\n') + '\n')
}

export async function prepareIdePluginReuse({ repository, currentTag, manifestPath, outputDirectory, previousTag, token = '', fetchImpl = fetch }) {
  normalizeVersion(currentTag)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const expectedFiles = Array.from(manifest.plugins || [], plugin => plugin.file)
  const endpoint = previousTag
    ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(previousTag)}`
    : `https://api.github.com/repos/${repository}/releases/latest`
  const previousRelease = await githubJson(endpoint, token, fetchImpl)
  ensureTag(previousRelease.tag_name)
  const assessment = assessIdePluginReuse({
    currentTag,
    previousRelease,
    expectedFiles,
    changedFiles: changedFilesBetween(previousRelease.tag_name, currentTag)
  })
  if (!assessment.reusable) return assessment
  await downloadAndVerifyIdePluginAssets({ assets: assessment.assets, outputDirectory, token, fetchImpl })
  return assessment
}

async function main() {
  const args = parseArguments()
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const result = await prepareIdePluginReuse({
    repository: args.repository,
    currentTag: args.tag,
    previousTag: args['previous-tag'],
    manifestPath: resolve(root, args.manifest || 'apps/desktop/src-tauri/resources/ide-plugins/manifest.json'),
    outputDirectory: resolve(root, args.output || 'apps/desktop/src-tauri/resources/ide-plugins'),
    token: process.env.GH_TOKEN || ''
  }).catch(error => ({ reusable: false, reason: error instanceof Error ? error.message : String(error) }))
  await writeOutput({ candidate: result.reusable, 'previous-tag': result.previousTag || '', reason: result.reason })
  console.log(result.reusable ? `Downloaded reusable IDE plugin assets from ${result.previousTag}` : `IDE plugin artifacts will be rebuilt: ${result.reason}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
