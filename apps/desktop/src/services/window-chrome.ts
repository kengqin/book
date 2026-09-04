import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window'

export type WindowPalette = 'startup' | 'app-light' | 'app-dark' | 'light' | 'paper' | 'night'

export function applicationWindowTheme(): Theme {
  const appearance = document.documentElement.dataset.appearance
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  return appearance === 'dark' || (appearance !== 'light' && prefersDark) ? 'dark' : 'light'
}

export async function setWindowChrome(theme: Theme | null, palette: WindowPalette | null) {
  if (!isTauri()) return
  try {
    await getCurrentWindow().setTheme(theme)
    await invoke('set_window_palette', { palette })
  } catch (error) {
    console.warn('window-theme-update-failed', error)
  }
}

export function syncApplicationWindowChrome() {
  if (document.documentElement.dataset.readerPalette) return Promise.resolve()
  const theme = applicationWindowTheme()
  return setWindowChrome(theme, theme === 'dark' ? 'app-dark' : 'app-light')
}
