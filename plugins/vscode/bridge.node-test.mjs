import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-runtime-home-'))
const bridge = require('./bridge.js')

test('bundled Runtime installs into the shared version directory with active rollback metadata', () => {
  const executable = bridge.__testInstallBundledRuntime()
  const root = bridge.__testSharedRuntimeRoot()
  const active = bridge.__testReadActiveRuntime(root)
  assert.equal(executable, path.join(root, 'versions', '1.0.1', 'novel-library-runtime.exe'))
  assert.equal(active.runtimeVersion, '1.0.1')
  assert.equal(active.executable, executable)
  assert.match(active.sha256, /^[a-f0-9]{64}$/)
  assert.equal(active.minimumClientProtocolVersion, 1)
  assert.equal(fs.existsSync(path.join(root, 'active.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'install.lock')), false)
  assert.equal(bridge.__testInstallBundledRuntime(), executable)
})

test('rejects a newer Runtime whose minimum client protocol excludes this plugin', () => {
  assert.equal(bridge.__testIsRuntimeCompatible({ protocolVersion: 3, minimumClientProtocolVersion: 3 }), false)
  assert.equal(bridge.__testIsRuntimeCompatible({ protocolVersion: 3, minimumClientProtocolVersion: 2 }), true)
  assert.equal(bridge.__testIsRuntimeCompatible({ protocolVersion: 2 }), true)
})

test('local data directory is configurable and copies an existing library', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-bridge-'))
  const oldDirectory = path.join(root, 'old')
  const newDirectory = path.join(root, 'new')
  fs.mkdirSync(oldDirectory, { recursive: true })
  fs.writeFileSync(path.join(oldDirectory, 'library.db'), 'fixture')
  fs.writeFileSync(path.join(oldDirectory, 'runtime.lock'), '999999')
  fs.writeFileSync(path.join(oldDirectory, 'migration.lock'), 'migration')
  fs.writeFileSync(path.join(oldDirectory, 'local-runtime.json'), '{"port":1}')
  const result = bridge.setLocalDataDirectory(newDirectory, { copyFrom: oldDirectory })
  assert.equal(result.directory, path.resolve(newDirectory))
  assert.equal(result.copied, true)
  assert.equal(fs.readFileSync(path.join(newDirectory, 'library.db'), 'utf8'), 'fixture')
  assert.equal(fs.existsSync(path.join(newDirectory, 'runtime.lock')), false)
  assert.equal(fs.existsSync(path.join(newDirectory, 'migration.lock')), false)
  assert.equal(fs.existsSync(path.join(newDirectory, 'local-runtime.json')), false)
})

test('migration lock serializes local directory moves', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-migration-lock-'))
  const lock = bridge.beginLocalDataMigration(directory)
  assert.equal(fs.existsSync(lock), true)
  assert.throws(() => bridge.beginLocalDataMigration(directory), /正在被其他客户端迁移/)
  bridge.endLocalDataMigration(lock)
  assert.equal(fs.existsSync(lock), false)
})

test('rejects copying a library into its own child directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-nested-'))
  const child = path.join(root, 'child')
  fs.writeFileSync(path.join(root, 'library.db'), 'fixture')
  assert.throws(() => bridge.setLocalDataDirectory(child, { copyFrom: root }), /不能是源目录或其子目录/)
})

test('refuses to overwrite an existing local library during a copy switch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-existing-target-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(source, 'library.db'), 'source-library')
  fs.writeFileSync(path.join(target, 'library.db'), 'target-library')

  assert.throws(
    () => bridge.setLocalDataDirectory(target, { copyFrom: source }),
    /目标目录已包含本地书库/
  )
  assert.equal(fs.readFileSync(path.join(target, 'library.db'), 'utf8'), 'target-library')
})

test('provider mode can be switched without changing the configured directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-provider-'))
  bridge.setLocalDataDirectory(directory)
  bridge.configureProvider({ useDesktopLibrary: false })
  const settings = bridge.getProviderSettings()
  assert.equal(settings.useDesktopLibrary, false)
  assert.equal(settings.localDataDirectory, path.resolve(directory))
  bridge.configureProvider({ useDesktopLibrary: true })
})

test('provider identity follows the persistent local storage id', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-library-provider-identity-'))
  bridge.configureProvider({ useDesktopLibrary: false, localDataDirectory: directory })
  fs.writeFileSync(path.join(directory, 'local-runtime.json'), JSON.stringify({
    port: 1234,
    token: 'token',
    storageId: 'local-storage-one'
  }))
  assert.equal(bridge.getProviderIdentity(), 'local:local-storage-one')
  bridge.configureProvider({ useDesktopLibrary: true })
})
