import { ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isVerificationPage } from './online-verification'
import { needsBrowserRendering } from './online-loading'

interface Page { url: string; html: string }
interface Verification { requestId: string; url: string; waiting: boolean }
export const onlineVerifications = ref<Verification[]>([])
const browserSites = new Set<string>()
let listening: Promise<unknown> | undefined
const cancelled = () => new DOMException('网页验证已取消', 'AbortError')
const host = (url: string) => new URL(url).hostname

export function showOnlineVerification(requestId: string) { return invoke<void>('show_online_browser', { requestId }) }
export function cancelOnlineVerification(requestId: string) { return invoke<void>('cancel_online_browser', { requestId }) }

async function browserPage(url: string, signal: AbortSignal | undefined, interactive: boolean): Promise<Page> {
  if (signal?.aborted) throw cancelled()
  listening ??= listen<Verification>('online-site-verification', ({ payload }) => {
    onlineVerifications.value = onlineVerifications.value.filter(item => item.requestId !== payload.requestId)
    if (payload.waiting) onlineVerifications.value.push(payload)
  }).catch(cause => { listening = undefined; throw cause })
  await listening
  if (signal?.aborted) throw cancelled()
  const requestId = crypto.randomUUID()
  const abort = () => { void cancelOnlineVerification(requestId).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const page = await invoke<Page>('fetch_online_browser', { url, requestId, interactive })
    if (signal?.aborted) throw cancelled()
    browserSites.add(host(url)); browserSites.add(host(page.url))
    return page
  } catch (cause) {
    if (signal?.aborted || /网页验证已取消|网页验证超时/u.test(String(cause))) throw cancelled()
    throw cause
  } finally {
    signal?.removeEventListener('abort', abort)
    onlineVerifications.value = onlineVerifications.value.filter(item => item.requestId !== requestId)
  }
}

export async function fetchOnlinePageWithVerification(url: string, signal?: AbortSignal, allowBrowser = true): Promise<Page> {
  if (signal?.aborted) throw cancelled()
  const browser = allowBrowser && isTauri()
  if (browser && browserSites.has(host(url))) return browserPage(url, signal, false)
  let page: Page
  try { page = await invoke<Page>('fetch_online_page', { url }) }
  catch (cause) {
    if (signal?.aborted) throw cancelled()
    // A browser can display the site's actual challenge without copying its cookies to HTTP.
    if (browser && /HTTP (403|429|503)/u.test(String(cause))) return browserPage(url, signal, false)
    throw cause
  }
  if (signal?.aborted) throw cancelled()
  if (browser && isVerificationPage(page.html)) return browserPage(page.url, signal, true)
  return browser && needsBrowserRendering(page.html) ? browserPage(page.url, signal, false) : page
}
