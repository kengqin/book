import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  state: {} as any, listeners: new Set<(event: any) => void>(), invoke: vi.fn(), getState: vi.fn(), check: vi.fn(), version: vi.fn()
}))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: native.version }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_event, listener) => { native.listeners.add(listener); return () => native.listeners.delete(listener) }) }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))

const update = { currentVersion: '0.7.0', version: '0.7.1' }
function snapshot(stage = 'downloaded', revision = 1, downloadedBytes = 100) {
  return { revision, stage, update, downloadedBytes, totalBytes: 100, message: '', error: '' }
}
function broadcast(state: ReturnType<typeof snapshot>) {
  native.state = state
  for (const listener of native.listeners) listener({ payload: structuredClone(state) })
}
beforeEach(() => {
  vi.resetModules()
  native.listeners.clear()
  native.state = snapshot()
  native.version.mockReset().mockResolvedValue('0.7.0')
  native.getState.mockReset().mockImplementation(async () => structuredClone(native.state))
  native.check.mockReset().mockRejectedValue(new Error('UPDATE_BUSY: 当前更新任务尚未完成'))
  native.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_application_update_state') return native.getState()
    if (command === 'check_application_update') return native.check()
    if (command === 'dismiss_application_update') { native.state = { ...native.state, promptDismissed: true, revision: native.state.revision + 1 }; broadcast(native.state); return }
    throw new Error(`Unexpected updater command ${command}`)
  })
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))
})

it('restores a downloaded installer in a newly created settings window without a network check', async () => {
  const settings = await import('./release-center')
  expect(settings.updateStage.value).toBe('idle')
  await settings.checkForUpdates(true)
  expect(settings.availableUpdate.value?.version).toBe('0.7.1')
  expect(settings.updateStage.value).toBe('downloaded')
  expect(settings.updateProgress.value).toBe(100)
  expect(settings.updateError.value).toBe('')
  expect(native.check).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('recovers progress and completion after closing one settings window and creating another', async () => {
  native.state = snapshot('downloading', 1, 40)
  const main = await import('./release-center')
  await main.initializeUpdateEvents()
  vi.resetModules()
  const firstSettings = await import('./release-center')
  const closeSettings = await firstSettings.initializeUpdateEvents()
  expect(firstSettings.updateProgress.value).toBe(40)
  closeSettings()
  broadcast(snapshot('downloaded', 2))
  expect(main.updateStage.value).toBe('downloaded')
  vi.resetModules()
  const reopenedSettings = await import('./release-center')
  await reopenedSettings.checkForUpdates(true)
  expect(reopenedSettings.updateStage.value).toBe('downloaded')
  expect(reopenedSettings.updateError.value).toBe('')
  expect(native.check).not.toHaveBeenCalled()
})

it('does not roll completion back when an earlier state request resolves late', async () => {
  let resolve!: (state: unknown) => void
  native.getState.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const settings = await import('./release-center')
  const ready = settings.initializeUpdateEvents()
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  broadcast(snapshot('downloaded', 3))
  resolve(snapshot('downloading', 2, 50))
  await ready
  expect(settings.updateStage.value).toBe('downloaded')
  expect(settings.updateProgress.value).toBe(100)
})

it('recovers a task that starts in another window during a check instead of reporting a connection error', async () => {
  native.state = snapshot('available', 1, 0)
  native.check.mockImplementation(async () => { native.state = snapshot('downloaded', 2); throw new Error('UPDATE_BUSY') })
  const settings = await import('./release-center')
  await settings.checkForUpdates()
  expect(settings.updateStage.value).toBe('downloaded')
  expect(settings.availableUpdate.value?.version).toBe('0.7.1')
  expect(settings.updateError.value).toBe('')
})

it('keeps a failed installation retryable after reopening settings', async () => {
  native.state = { ...snapshot('install-error'), error: 'INSTALL_ERROR: installer could not start' }
  const settings = await import('./release-center')
  await settings.checkForUpdates(true)
  expect(settings.updateStage.value).toBe('install-error')
  expect(settings.availableUpdate.value?.version).toBe('0.7.1')
  expect(settings.updateError.value).toContain('可重新安装')
  expect(native.check).not.toHaveBeenCalled()
})

it('restores an installed task as awaiting restart instead of checking or downloading again', async () => {
  native.state = snapshot('installed')
  const settings = await import('./release-center')
  await settings.checkForUpdates(true)
  expect(settings.updateStage.value).toBe('installed')
  expect(native.check).not.toHaveBeenCalled()
})

it('defers a prompt while retaining the downloaded package and install action', async () => {
  const settings = await import('./release-center')
  await settings.initializeUpdateEvents()
  await settings.dismissUpdate()
  expect(settings.updatePromptDismissed.value).toBe(true)
  expect(settings.updateStage.value).toBe('downloaded')
  expect(settings.updateDownloadedBytes.value).toBe(100)
  expect(settings.availableUpdate.value?.version).toBe('0.7.1')
})

it('remembers the ignored version across windows without ignoring the next version', async () => {
  const first = await import('./release-center')
  await first.initializeUpdateEvents()
  await first.ignoreUpdate()
  vi.resetModules()
  native.state = { ...snapshot('downloaded', 3), update: { ...update, version: '0.7.2' } }
  const next = await import('./release-center')
  await next.initializeUpdateEvents()
  expect(next.ignoredUpdateVersion.value).toBe('0.7.1')
  expect(next.availableUpdate.value?.version).toBe('0.7.2')
  expect(next.updatePromptDismissed.value).toBe(false)
})
