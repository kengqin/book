import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assessIdePluginReuse, downloadAndVerifyIdePluginAssets, isIdePluginBuildInput } from './prepare-ide-plugin-reuse.mjs'

const expectedFiles = [
  'novel-library-reader-0.5.2.vsix',
  'novel-library-intellij-0.5.2.zip',
  'novel-library-visual-studio-0.5.2.vsix'
]

function stableRelease(overrides = {}) {
  return {
    tag_name: 'v0.6.15',
    draft: false,
    prerelease: false,
    assets: expectedFiles.map((name, index) => ({
      name,
      size: index + 1,
      digest: `sha256:${String(index + 1).repeat(64)}`,
      url: `https://api.github.com/assets/${index + 1}`
    })),
    ...overrides
  }
}

describe('IDE plugin artifact reuse', () => {
  it('allows a desktop-only release to reuse three complete stable assets', () => {
    const result = assessIdePluginReuse({
      currentTag: 'v0.6.16',
      previousRelease: stableRelease(),
      expectedFiles,
      changedFiles: ['apps/desktop/src/main.ts', 'CHANGELOG.md', 'releases/releases.json']
    })
    expect(result.reusable).toBe(true)
    expect(result.assets).toHaveLength(3)
  })

  it.each([
    'apps/local-runtime/src/main.rs',
    'packages/reader-protocol/src/index.ts',
    'plugins/vscode/extension.js',
    'plugins/intellij/src/main/resources/META-INF/plugin.xml',
    'plugins/visual-studio/NovelLibraryBridge.cs',
    'apps/desktop/src-tauri/resources/ide-plugins/manifest.json',
    'scripts/stage-ide-plugin-runtime.ps1',
    'scripts/package-visual-studio-plugin.ps1'
  ])('forces a rebuild when %s changes', changedFile => {
    expect(isIdePluginBuildInput(changedFile)).toBe(true)
    const result = assessIdePluginReuse({ currentTag: 'v0.6.16', previousRelease: stableRelease(), expectedFiles, changedFiles: [changedFile] })
    expect(result.reusable).toBe(false)
    expect(result.reason).toContain('build inputs changed')
  })

  it('rejects missing, empty, duplicate, or unsigned release assets', () => {
    const invalidReleases = [
      stableRelease({ assets: stableRelease().assets.slice(0, 2) }),
      stableRelease({ assets: stableRelease().assets.map((asset, index) => index === 0 ? { ...asset, size: 0 } : asset) }),
      stableRelease({ assets: [...stableRelease().assets, stableRelease().assets[0]] }),
      stableRelease({ assets: stableRelease().assets.map((asset, index) => index === 0 ? { ...asset, digest: null } : asset) })
    ]
    for (const previousRelease of invalidReleases) {
      expect(assessIdePluginReuse({ currentTag: 'v0.6.16', previousRelease, expectedFiles, changedFiles: [] }).reusable).toBe(false)
    }
  })

  it('rejects prereleases, the current release, and unsafe manifest filenames', () => {
    expect(assessIdePluginReuse({ currentTag: 'v0.6.16', previousRelease: stableRelease({ prerelease: true }), expectedFiles, changedFiles: [] }).reusable).toBe(false)
    expect(assessIdePluginReuse({ currentTag: 'v0.6.15', previousRelease: stableRelease(), expectedFiles, changedFiles: [] }).reusable).toBe(false)
    expect(assessIdePluginReuse({ currentTag: 'v0.6.16', previousRelease: stableRelease(), expectedFiles: ['../unsafe.vsix', ...expectedFiles.slice(1)], changedFiles: [] }).reusable).toBe(false)
  })

  it('downloads all candidates only when size and SHA-256 match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'novel-library-reuse-test-'))
    const payloads = expectedFiles.map(name => Buffer.from(`verified ${name}`))
    const assets = expectedFiles.map((name, index) => ({
      name,
      size: payloads[index].length,
      sha256: createHash('sha256').update(payloads[index]).digest('hex'),
      url: `https://api.github.com/assets/${index + 1}`
    }))
    const fetchImpl = vi.fn(async url => {
      const index = Number(String(url).split('/').at(-1)) - 1
      return new Response(payloads[index])
    })
    await downloadAndVerifyIdePluginAssets({ assets, outputDirectory: directory, fetchImpl })
    expect(await readFile(join(directory, expectedFiles[1]), 'utf8')).toBe(`verified ${expectedFiles[1]}`)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('rejects a downloaded asset whose bytes do not match its digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'novel-library-reuse-test-'))
    const bytes = Buffer.from('tampered')
    await expect(downloadAndVerifyIdePluginAssets({
      assets: [{ name: expectedFiles[0], size: bytes.length, sha256: '0'.repeat(64), url: 'https://api.github.com/assets/1' }],
      outputDirectory: directory,
      fetchImpl: async () => new Response(bytes)
    })).rejects.toThrow('SHA-256')
  })
})
