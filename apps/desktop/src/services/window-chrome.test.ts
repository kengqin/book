// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, setTheme } = vi.hoisted(() => ({ invoke: vi.fn(), setTheme: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme }) }))

import { setReaderWindowPalette, syncApplicationWindowChrome } from './window-chrome'

beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.dataset.appearance = 'light'
  delete document.documentElement.dataset.readerPalette
})

describe('reader appearance isolation', () => {
  it.each(['light', 'paper', 'night'] as const)('%s only changes reader window colors', async palette => {
    await setReaderWindowPalette(palette)
    expect(invoke).toHaveBeenCalledWith('set_window_palette', { palette })
    expect(setTheme).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.appearance).toBe('light')
  })

  it.each(['light', 'dark'] as const)('restores the %s application appearance after reading', async appearance => {
    document.documentElement.dataset.appearance = appearance
    document.documentElement.dataset.readerPalette = 'night'
    await setReaderWindowPalette('night')
    await syncApplicationWindowChrome()
    expect(setTheme).not.toHaveBeenCalled()
    delete document.documentElement.dataset.readerPalette
    await syncApplicationWindowChrome()
    expect(setTheme).toHaveBeenCalledWith(appearance)
    expect(invoke).toHaveBeenLastCalledWith('set_window_palette', { palette: `app-${appearance}` })
  })
})
