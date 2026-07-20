import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPaths, inspectBuildRecord, saveBuildRecord } from './incremental-build.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mobile-incremental-build-'))
  temporaryDirectories.push(root)
  const input = join(root, 'src/input.ts')
  const output = join(root, 'dist/app.js')
  const record = join(root, 'cache/web.json')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(input, 'export const value = 1\n')
  await writeFile(output, 'console.log(1)\n')
  return { root, input, output, record }
}

describe('mobile incremental build cache', () => {
  it('reuses an unchanged input and verified artifact', async () => {
    const item = await fixture()
    const fingerprint = await fingerprintPaths([item.input], { base: item.root })
    await saveBuildRecord(item.record, { inputHash: fingerprint.hash, outputs: [item.output] }, item.root)
    const state = await inspectBuildRecord(item.record, { inputHash: fingerprint.hash, outputs: [item.output] }, item.root)
    expect(state.reusable).toBe(true)
  })

  it('invalidates the cache when an input changes', async () => {
    const item = await fixture()
    const initial = await fingerprintPaths([item.input], { base: item.root })
    await saveBuildRecord(item.record, { inputHash: initial.hash, outputs: [item.output] }, item.root)
    await writeFile(item.input, 'export const value = 2\n')
    const changed = await fingerprintPaths([item.input], { base: item.root })
    const state = await inspectBuildRecord(item.record, { inputHash: changed.hash, outputs: [item.output] }, item.root)
    expect(changed.hash).not.toBe(initial.hash)
    expect(state).toMatchObject({ reusable: false, reason: '输入文件发生变化' })
  })

  it('invalidates the cache when an artifact is modified', async () => {
    const item = await fixture()
    const fingerprint = await fingerprintPaths([item.input], { base: item.root })
    await saveBuildRecord(item.record, { inputHash: fingerprint.hash, outputs: [item.output] }, item.root)
    await writeFile(item.output, 'console.log(2)\n')
    const state = await inspectBuildRecord(item.record, { inputHash: fingerprint.hash, outputs: [item.output] }, item.root)
    expect(state.reusable).toBe(false)
    expect(state.reason).toContain('产物已被修改')
  })
})
