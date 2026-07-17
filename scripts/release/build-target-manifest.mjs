import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  TARGET_KEY,
  assertOfficialDownloadUrl,
  assertSignature,
  findRelease,
  installerDownloadUrl,
  installerNameFromRelease,
  notesFromRelease,
  normalizeVersion,
  parseArguments,
  sha256File
} from './release-utils.mjs'

export async function buildTargetManifest(options) {
  const version = normalizeVersion(options.version)
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'))
  const release = findRelease(manifest, version)
  const installerName = options.installerName || options.installer?.split(/[\\/]/).at(-1)
  if (!installerName) throw new Error('缺少安装包文件名')
  if (installerNameFromRelease(release) !== installerName) {
    throw new Error(`安装包文件名与版本目录不一致：${installerName}`)
  }
  const url = installerDownloadUrl(manifest.repository, version, installerName)
  assertOfficialDownloadUrl(release.installerUrl, manifest.repository, version, installerName)
  const signature = assertSignature(options.signatureValue || await readFile(options.signature, 'utf8'))

  if (options.installer) {
    const checksum = await sha256File(options.installer)
    if (release.sha256.toLowerCase() !== checksum) {
      throw new Error(`安装包 SHA256 与版本目录不一致：期望 ${release.sha256}，实际 ${checksum}`)
    }
    if (options.checksumOutput) {
      await writeFile(options.checksumOutput, `${checksum}  ${installerName}\n`, 'ascii')
    }
  }

  const pubDate = options.pubDate || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`发布时间无效：${pubDate}`)
  const target = {
    version,
    notes: notesFromRelease(release),
    pub_date: pubDate,
    url,
    signature
  }
  const platform = { url, signature }
  const legacy = {
    version,
    notes: target.notes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': platform,
      [TARGET_KEY]: platform
    }
  }

  if (options.output) await writeFile(options.output, `${JSON.stringify(target, null, 2)}\n`, 'utf8')
  if (options.latestOutput) await writeFile(options.latestOutput, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
  return { target, legacy }
}

async function main() {
  const args = parseArguments()
  for (const required of ['version', 'manifest', 'installer', 'signature', 'output']) {
    if (!args[required]) throw new Error(`缺少 --${required}`)
  }
  await buildTargetManifest({
    version: args.version,
    manifest: args.manifest,
    installer: args.installer,
    signature: args.signature,
    output: args.output,
    latestOutput: args['latest-output'],
    checksumOutput: args['checksum-output'],
    pubDate: args['pub-date']
  })
  console.log(`Generated ${args.output}${args['latest-output'] ? ` and ${args['latest-output']}` : ''}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
