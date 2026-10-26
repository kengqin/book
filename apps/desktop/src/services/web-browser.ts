import { ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { showGlobalMessage } from './global-message'

export type WebBrowserMode = 'window' | 'side'
export interface WebBrowserTab { id: number; url: string; title: string; favicon?: string; loading: boolean; zoomFactor: number }
export interface WebBrowserState { open: boolean; mode: WebBrowserMode; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; menuOpen?: boolean; sideSuspended?: boolean; pageVisible?: boolean; zoomFactor?: number; tabs?: WebBrowserTab[]; activeTab?: number }
const preference = 'novel-library-web-browser-mode'
export const webBrowser = ref<WebBrowserState>({ open: false, mode: 'window', url: '', title: '', loading: false, canGoBack: false, canGoForward: false })
export const browserMode = () => localStorage.getItem(preference) === 'side' ? 'side' : 'window'
export const browserAddressRequest = ref(0)
export const browserSideWidth = ref(Math.max(320, Math.min(760, Number(localStorage.getItem('novel-library-web-browser-width')) || 440)))
export function saveBrowserWidth(width: number) { browserSideWidth.value = width; localStorage.setItem('novel-library-web-browser-width', String(width)) }
export function webPageUrl(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
let listening: Promise<void> | undefined
function accept(state: WebBrowserState) {
  webBrowser.value = state
  if (state.open) localStorage.setItem(preference, state.mode)
}
export function initializeWebBrowser() {
  if (!isTauri()) return Promise.resolve()
  listening ??= Promise.all([
    listen<WebBrowserState>('web-browser-state', ({ payload }) => accept(payload)),
    listen('web-browser-edit-address', () => { browserAddressRequest.value++ }),
    listen('web-browser-copied', () => {
      if (getCurrentWebview().label === (webBrowser.value.mode === 'side' ? 'main' : 'web-browser')) showGlobalMessage('链接已复制')
    })
  ]).then(async () => {
    // An unopened browser must not overwrite the saved preference on app startup.
    const state = await invoke<WebBrowserState>('get_web_browser_state')
    webBrowser.value = state
  }).catch(error => { listening = undefined; throw error })
  return listening
}
export async function refreshWebBrowser() { webBrowser.value = await invoke<WebBrowserState>('get_web_browser_state') }
export async function openWebPage(url: string) {
  const safe = webPageUrl(url)
  if (!safe) throw new Error('请输入 HTTP 或 HTTPS 网页地址')
  if (!isTauri()) { window.open(safe, '_blank', 'noopener,noreferrer'); return }
  await initializeWebBrowser()
  await invoke('open_web_browser', { url: safe, mode: browserMode(), newTab: true })
}
export function browserAddress(value: string) {
  const input = value.trim()
  if (!input) return undefined
  if (/^[a-z][a-z\d+.-]*:/iu.test(input)) {
    const url = webPageUrl(input)
    if (!url) throw new Error('只支持 HTTP 或 HTTPS 网页地址')
    return url
  }
  if (/^[^\s/]+\.[^\s/]+(?:[/:?#]|$)/u.test(input)) return webPageUrl('https://' + input)
  return `https://cn.bing.com/search?q=${encodeURIComponent(input)}`
}
export async function navigateWebPage(input: string) {
  const url = browserAddress(input)
  if (url) await invoke('open_web_browser', { url, mode: webBrowser.value.mode, newTab: false })
}
export async function changeWebBrowserMode(mode: WebBrowserMode) {
  await invoke('set_web_browser_mode', { mode })
  localStorage.setItem(preference, mode)
}
export const closeWebBrowser = () => invoke<void>('close_web_browser')
export const selectBrowserTab = (tabId: number) => invoke<void>('switch_web_browser_tab', { tabId })
export const closeBrowserTab = (tabId: number) => invoke<void>('close_web_browser_tab', { tabId })
export const closeBrowserMenu = () => invoke<void>('close_web_browser_menu')
export async function zoomWebPage(action: 'reset' | 'out' | 'in') {
  const levels = [.5, .67, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2]
  const current = webBrowser.value.zoomFactor || 1
  const factor = action === 'reset' ? 1 : action === 'in' ? levels.find(value => value > current + .01) || 2 : levels.filter(value => value < current - .01).at(-1) || .5
  await invoke('set_web_browser_zoom', { factor })
  await refreshWebBrowser()
}
export async function requestBrowserAddress() { await emitTo(webBrowser.value.mode === 'side' ? 'main' : 'web-browser', 'web-browser-edit-address'); await closeBrowserMenu() }
export async function copyBrowserLink() {
  await navigator.clipboard.writeText(webBrowser.value.url)
  await emitTo(webBrowser.value.mode === 'side' ? 'main' : 'web-browser', 'web-browser-copied')
  await closeBrowserMenu()
}
export const webBrowserAction = (action: 'back' | 'forward' | 'reload' | 'stop' | 'external') => invoke<void>('web_browser_action', { action })
