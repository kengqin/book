import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { buildTargetManifest } from './build-target-manifest.mjs'
import { verifyPublishedRelease } from './verify-published-release.mjs'

const repository = 'kengqin/book'
const version = '1.2.3'
const installerName = 'NovelLibrary_1.2.3_x64-setup.exe'
const signature = 'A'.repeat(80)

function releaseCatalog(sha256) {
  return {
    schemaVersion: 1,
    repository,
    latest: version,
    releases: [{
      version,
      date: '2026-07-17',
      title: 'Release test',
      channel: 'stable',
      databaseSchema: 5,
      published: true,
      minimumSupportedVersion: '1.0.0',
      requiresBackup: false,
      releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
      installerUrl: `https://github.com/${repository}/releases/download/v${version}/${installerName}`,
      sha256,
      sections: [{ title: 'Fix', items: ['Verified release'] }],
      upgradeNotes: []
    }]
  }
}

describe('desktop release scripts', () => {
  it('generates target and legacy manifests from the same catalog entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'novel-release-'))
    const installer = join(directory, installerName)
    const signatureFile = `${installer}.sig`
    const manifestFile = join(directory, 'releases.json')
    const targetFile = join(directory, 'target.json')
    const latestFile = join(directory, 'latest.json')
    const checksumFile = `${installer}.sha256`
    const bytes = Buffer.from('signed installer fixture')
    const hash = createHash('sha256').update(bytes).digest('hex')
    await Promise.all([
      writeFile(installer, bytes),
      writeFile(signatureFile, signature),
      writeFile(manifestFile, JSON.stringify(releaseCatalog(hash)))
    ])

    const result = await buildTargetManifest({
      version,
      manifest: manifestFile,
      installer,
      signature: signatureFile,
      output: targetFile,
      latestOutput: latestFile,
      checksumOutput: checksumFile,
      pubDate: '2026-07-17T10:00:00Z'
    })

    expect(result.target.version).toBe(version)
    expect(result.target.url).toContain(`/v${version}/${installerName}`)
    expect(result.legacy.platforms['windows-x86_64-nsis'].signature).toBe(signature)
    expect(await readFile(checksumFile, 'utf8')).toContain(hash)
  })

  it('fails before publishing when the built installer checksum differs from the catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'novel-release-'))
    const installer = join(directory, installerName)
    const signatureFile = `${installer}.sig`
    const manifestFile = join(directory, 'releases.json')
    await Promise.all([
      writeFile(installer, 'unexpected bytes'),
      writeFile(signatureFile, signature),
      writeFile(manifestFile, JSON.stringify(releaseCatalog('0'.repeat(64))))
    ])

    await expect(buildTargetManifest({
      version,
      manifest: manifestFile,
      installer,
      signature: signatureFile,
      output: join(directory, 'target.json')
    })).rejects.toThrow('SHA256')
  })

  it('verifies public assets, signatures, checksums, target metadata and latest alias together', async () => {
    const bytes = Buffer.from('public installer fixture')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const catalog = releaseCatalog(hash)
    const url = catalog.releases[0].installerUrl
    const target = {
      version,
      notes: 'Release test',
      pub_date: '2026-07-17T10:00:00Z',
      url,
      signature
    }
    const latest = {
      version,
      notes: target.notes,
      pub_date: target.pub_date,
      platforms: {
        'windows-x86_64': { url, signature },
        'windows-x86_64-nsis': { url, signature }
      }
    }
    const assets = [installerName, `${installerName}.sig`, `${installerName}.sha256`, 'latest-windows-x86_64-nsis.json', 'SHA256SUMS.txt']
    const fetchImpl = vi.fn(async (requestUrl) => {
      const value = String(requestUrl)
      if (value.includes('api.github.com')) return new Response(JSON.stringify({ draft: false, prerelease: false, assets: assets.map((name) => ({ name })) }))
      if (value.endsWith('latest-windows-x86_64-nsis.json')) return new Response(JSON.stringify(target))
      if (value.endsWith('.sig')) return new Response(signature)
      if (value.endsWith('.sha256')) return new Response(`${hash}  ${installerName}\n`)
      if (value.endsWith('SHA256SUMS.txt')) return new Response(`${hash}  ${installerName}\n`)
      if (value.endsWith(installerName)) return new Response(bytes)
      if (value.endsWith('latest.json')) return new Response(JSON.stringify(latest))
      return new Response('', { status: 404 })
    })

    const result = await verifyPublishedRelease({
      repository,
      tag: `v${version}`,
      version,
      manifest: catalog,
      expectedState: 'stable',
      verifyLatest: true,
      fetchImpl,
      token: ''
    })

    expect(result.sha256).toBe(hash)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/releases/latest/download/latest.json'), {})
  })
})
