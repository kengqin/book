import type { BundledIdePlugin, IdeTarget } from './desktop-library'

function versionParts(version: string) {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map(part => Number.parseInt(part, 10))
    .map(part => Number.isFinite(part) ? part : 0)
}

export function comparePluginVersions(left: string, right: string) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

export function idePluginUpdateAvailable(target: IdeTarget, plugin: BundledIdePlugin) {
  return Boolean(
    target.installed
      && target.installedVersion
      && comparePluginVersions(target.installedVersion, plugin.version) < 0
  )
}
