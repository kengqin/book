import { describe, expect, it } from 'vitest'
import { validateReleaseHistory } from './release-utils.mjs'

function catalog(repository) {
  return {
    repository,
    releases: [{
      version: '0.7.4',
      date: '2026-10-29',
      title: 'Release',
      published: true,
      sha256: 'a'.repeat(64),
      releaseUrl: `https://github.com/${repository}/releases/tag/v0.7.4`,
      installerUrl: `https://github.com/${repository}/releases/download/v0.7.4/NovelLibrary_0.7.4_x64-setup.exe`,
      sections: [{ title: 'Fix', items: ['Existing change'] }]
    }]
  }
}

describe('immutable release history across repository renames', () => {
  const oldRepository = 'kengqin/book'
  const newRepository = 'kengqin/library-manage'

  it('allows the same tags and assets to move to the renamed repository', () => {
    expect(() => validateReleaseHistory(catalog(newRepository), catalog(oldRepository))).not.toThrow()
  })

  it.each([
    ['title', 'Changed release'],
    ['date', '2026-10-30'],
    ['sha256', 'b'.repeat(64)],
    ['releaseUrl', `https://github.com/${newRepository}/releases/tag/v0.7.5`],
    ['installerUrl', `https://github.com/${newRepository}/releases/download/v0.7.4/Other-setup.exe`],
    ['installerUrl', `https://example.com/${newRepository}/releases/download/v0.7.4/NovelLibrary_0.7.4_x64-setup.exe`]
  ])('rejects changes to %s during a rename', (key, value) => {
    const current = catalog(newRepository)
    current.releases[0][key] = value
    expect(() => validateReleaseHistory(current, catalog(oldRepository))).toThrow('已发布记录不可覆盖')
  })

  it('still rejects deleted releases', () => {
    expect(() => validateReleaseHistory({ repository: newRepository, releases: [] }, catalog(oldRepository))).toThrow('被删除')
  })

  it('does not rewrite unrelated links inside release notes', () => {
    const current = catalog(newRepository)
    const baseline = catalog(oldRepository)
    baseline.releases[0].sections[0].items = [`https://github.com/${oldRepository}/releases/tag/v0.7.4`]
    current.releases[0].sections[0].items = [`https://github.com/${newRepository}/releases/tag/v0.7.4`]
    expect(() => validateReleaseHistory(current, baseline)).toThrow('已发布记录不可覆盖')
  })
})
