import { describe, expect, it } from 'vitest'
import type { BundledIdePlugin, IdeTarget } from './desktop-library'
import { comparePluginVersions, idePluginUpdateAvailable } from './ide-plugin-update'

const plugin = { version: '0.4.7' } as BundledIdePlugin

function target(installedVersion?: string, installed = true) {
  return { installed, installedVersion } as IdeTarget
}

describe('IDE plugin updates', () => {
  it('orders numeric version segments', () => {
    expect(comparePluginVersions('0.4.6', '0.4.7')).toBe(-1)
    expect(comparePluginVersions('0.4.10', '0.4.7')).toBe(1)
    expect(comparePluginVersions('v0.4.7', '0.4.7')).toBe(0)
  })

  it('offers an update only for an installed older version', () => {
    expect(idePluginUpdateAvailable(target('0.4.6'), plugin)).toBe(true)
    expect(idePluginUpdateAvailable(target('0.4.7'), plugin)).toBe(false)
    expect(idePluginUpdateAvailable(target('0.4.8'), plugin)).toBe(false)
    expect(idePluginUpdateAvailable(target(), plugin)).toBe(false)
    expect(idePluginUpdateAvailable(target('0.4.6', false), plugin)).toBe(false)
  })
})
