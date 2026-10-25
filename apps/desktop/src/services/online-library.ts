import { reactive, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { discoverCatalog, extractChapter, type DiscoveryProgress, type OnlineCatalog } from './online-parser'
import { invalidateDesktopBookCache } from './desktop-library'
import { OnlineRequestQueue, type RequestPriority } from './online-request-queue'
import { fetchOnlinePageWithVerification } from './online-browser'
import { filterNovelHits, parseSearchPage, searchBrowserUrl, searchEngineOptions, searchPublicBooks, type OnlineSearchHit, type SearchEngine, type SearchPage } from './online-search'
export type { OnlineSearchHit } from './online-search'

export interface OnlineChapter { number: number; title: string; url: string; status: 'pending' | 'cached' | 'failed'; error: string }
export interface OnlineBook { bookId: string; title: string; catalogUrl: string; state: string; autoUpdate: boolean; lastChecked: number; error: string; taskVisible: boolean; catalogComplete: boolean; chapters: OnlineChapter[] }
export const onlineBooks = ref<OnlineBook[]>([])
const savedProvider = localStorage.getItem('novel-library-search-engine') || 'bing'
export const onlineSearchSettings = reactive({ provider: (searchEngineOptions.some(option => option.value === savedProvider) ? savedProvider : 'bing') as SearchEngine, apiKey: '', novelOnly: localStorage.getItem('novel-library-search-novel-only') !== 'false' })
const runners = new Map<string, Promise<void>>()
const stopped = new Set<string>()
interface ChapterTask { bookId: string; priority: RequestPriority; done: Promise<void> }
const chaptersInFlight = new Map<string, ChapterTask>()
const checksInFlight = new Map<string, { controller: AbortController; done: Promise<number> }>()
const requests = new OnlineRequestQueue()
let initialized = false
const delay = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
function updateChapter(bookId: string, number: number, status: OnlineChapter['status'], error: string) {
  const chapter = onlineBooks.value.find(book => book.bookId === bookId)?.chapters.find(chapter => chapter.number === number)
  if (chapter) { chapter.status = status; chapter.error = error }
}

/** Return pages as soon as they arrive; pacing applies to starts on the same host. */
export function fetchOnlinePage(url: string, signal?: AbortSignal, allowBrowser = true): Promise<{ url: string; html: string }> {
  return requests.run(url, () => fetchOnlinePageWithVerification(url, signal, allowBrowser), { signal })
}

export async function refreshOnlineBooks() {
  onlineBooks.value = await invoke<OnlineBook[]>('list_online_books')
  return onlineBooks.value
}

export async function searchOnlineBooks(query: string, apiKey: string, engine: SearchEngine = onlineSearchSettings.provider, cursor?: string, options: { browser?: boolean; onBrowser?: (interactive: boolean) => void; novelOnly?: boolean } = {}): Promise<SearchPage> {
  const novelOnly = options.novelOnly ?? onlineSearchSettings.novelOnly
  if (engine === 'brave') {
    const offset = Number(cursor || 0)
    const rawHits = await invoke<OnlineSearchHit[]>('search_online_books', { query, apiKey, offset })
    return { hits: filterNovelHits(rawHits, novelOnly), next: rawHits.length && offset < 9 ? String(offset + 1) : undefined }
  }
  const browser = async (interactive: boolean): Promise<SearchPage> => {
    options.onBrowser?.(interactive)
    try {
      const page = await invoke<{ url: string; html: string }>('fetch_search_browser', { url: cursor || searchBrowserUrl(engine, query), interactive })
      return parseSearchPage(page.html, page.url, engine, novelOnly)
    } catch (cause) {
      if (!interactive && /需要网页确认|要求网页验证|网页搜索尚未就绪/u.test(message(cause))) return browser(true)
      throw cause
    }
  }
  if (options.browser) return browser(true)
  if (['bing', 'google', 'duckduckgo'].includes(engine) && isTauri()) return browser(false)
  try {
    const result = await searchPublicBooks(engine, query, url => fetchOnlinePage(url, undefined, false), cursor, novelOnly)
    if (!result.hits.length && !result.next && isTauri()) return browser(false)
    return result
  }
  catch (cause) {
    if (isTauri() && /要求网页验证|要求浏览器|HTTP (403|429)|网页请求失败/u.test(message(cause))) return browser(false)
    throw cause
  }
}

export function cancelBrowserSearch() { return invoke<void>('cancel_search_browser') }

export function analyzeOnlineLink(url: string, progress?: (value: DiscoveryProgress) => void) {
  return discoverCatalog(url, fetchOnlinePage, progress)
}

export async function addOnlineBook(catalog: OnlineCatalog, options: { reveal?: boolean } = {}) {
  const bookId = await invoke<string>('save_online_catalog', { input: catalog })
  if (options.reveal !== false) await setState(bookId, { taskVisible: true })
  invalidateDesktopBookCache()
  await refreshOnlineBooks()
  return bookId
}

async function setState(bookId: string, values: { status?: string; autoUpdate?: boolean; error?: string; taskVisible?: boolean }) {
  await invoke('set_online_state', { bookId, ...values })
  const book = onlineBooks.value.find(b => b.bookId === bookId)
  if (book) {
    if (values.status !== undefined) book.state = values.status
    if (values.autoUpdate !== undefined) book.autoUpdate = values.autoUpdate
    if (values.error !== undefined) book.error = values.error
    if (values.taskVisible !== undefined) book.taskVisible = values.taskVisible
  }
}

export async function ensureOnlineChapter(bookId: string, number: number, priority: RequestPriority = 'foreground') {
  const key = `${bookId}:${number}`
  const existing = chaptersInFlight.get(key)
  if (existing) {
    if (priority === 'foreground') { existing.priority = priority; requests.promote(existing) }
    return existing.done
  }
  const task: ChapterTask = { bookId, priority, done: Promise.resolve() }
  const fetchChapterPage = (url: string) => {
    if (task.priority === 'background' && stopped.has(bookId)) return Promise.reject(new DOMException('下载已暂停', 'AbortError'))
    return requests.run(url, () => fetchOnlinePageWithVerification(url), { priority: task.priority, group: task })
  }
  task.done = (async () => {
    let book = onlineBooks.value.find(b => b.bookId === bookId)
    if (!book) book = (await refreshOnlineBooks()).find(b => b.bookId === bookId)
    const chapter = book?.chapters.find(c => c.number === number)
    if (!chapter || chapter.status === 'cached') return
    let failure = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const content = await extractChapter(chapter.url, fetchChapterPage, new Set(book?.chapters.map(chapter => chapter.url)))
        await invoke('store_online_chapter', { bookId, number, content, error: '' })
        updateChapter(bookId, number, 'cached', '')
        invalidateDesktopBookCache()
        return
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
        failure = message(cause)
        if (!/超时|传输中断|HTTP (429|5\d\d)|请求失败/u.test(failure) || attempt === 2) break
        await delay(1500 * (attempt + 1))
      }
    }
    await invoke('store_online_chapter', { bookId, number, content: '', error: failure })
    updateChapter(bookId, number, 'failed', failure)
    throw new Error(failure)
  })()
  chaptersInFlight.set(key, task)
  try { await task.done } finally { chaptersInFlight.delete(key) }
}

function stopQueuedChapters(bookId: string) {
  for (const task of chaptersInFlight.values()) if (task.bookId === bookId && task.priority === 'background') requests.cancelQueued(task)
}

export function downloadOnlineBook(bookId: string): Promise<void> {
  if (runners.has(bookId)) {
    if (stopped.has(bookId)) return runners.get(bookId)!.then(() => downloadOnlineBook(bookId))
    return runners.get(bookId)!
  }
  stopped.delete(bookId)
  const work = (async () => {
    await setState(bookId, { status: 'downloading', error: '', taskVisible: true })
    let book = onlineBooks.value.find(b => b.bookId === bookId)
    if (!book) throw new Error('在线书籍已删除')
    if (book.catalogComplete === false) {
      const { ensureCatalogComplete } = await import('./online-discovery')
      await ensureCatalogComplete(bookId)
      book = onlineBooks.value.find(b => b.bookId === bookId)
      if (!book || book.catalogComplete === false) throw new Error('目录尚未完整，已保留现有章节，请重试检查更新')
    }
    let consecutiveFailures = 0
    for (const chapter of book.chapters) {
      if (stopped.has(bookId)) return
      if (chapter.status === 'cached') continue
      try { await ensureOnlineChapter(bookId, chapter.number, 'background'); consecutiveFailures = 0 }
      catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          if (!stopped.has(bookId)) {
            stopped.add(bookId)
            await setState(bookId, { status: 'paused', error: '网页验证未完成，可继续下载重试' })
          }
          return
        }
        consecutiveFailures++
      }
      if (consecutiveFailures >= 5) break
    }
    if (stopped.has(bookId)) return
    const latest = (await refreshOnlineBooks()).find(b => b.bookId === bookId)
    if (!latest) return
    const complete = latest.chapters.every(c => c.status === 'cached')
    await setState(bookId, { status: complete ? 'complete' : 'failed', error: complete ? '' : '部分章节未完成，可重试失败章节；连续失败时任务会停止。' })
  })().catch(async cause => { if (!stopped.has(bookId)) await setState(bookId, { status: 'failed', error: message(cause) }) }).finally(() => runners.delete(bookId))
  runners.set(bookId, work)
  return work
}

export async function pauseOnlineBook(bookId: string, cancel = false) {
  stopped.add(bookId)
  stopQueuedChapters(bookId)
  await setState(bookId, { status: cancel ? 'cancelled' : 'paused' })
  if (cancel) {
    await cancelUpdateCheck(bookId)
    const { cancelCatalogForBook } = await import('./online-discovery')
    await cancelCatalogForBook(bookId)
  }
  // An already-started chapter may finish; no new chapter starts after the stop request.
}

export async function removeOnlineTask(bookId: string) {
  stopped.add(bookId)
  stopQueuedChapters(bookId)
  await cancelUpdateCheck(bookId)
  const { cancelCatalogForBook } = await import('./online-discovery')
  await cancelCatalogForBook(bookId)
  await setState(bookId, { status: 'cancelled', taskVisible: false, autoUpdate: false })
}

export async function restoreOnlineTask(bookId: string) {
  await setState(bookId, { taskVisible: true })
}

export async function toggleOnlineUpdates(bookId: string, enabled: boolean) {
  await setState(bookId, { autoUpdate: enabled })
}

async function cancelUpdateCheck(bookId: string) {
  const check = checksInFlight.get(bookId)
  if (check) { check.controller.abort(); await check.done.catch(() => {}) }
}

export function checkOnlineUpdates(bookId: string): Promise<number> {
  if (checksInFlight.has(bookId)) return Promise.reject(new Error('这本书正在检查更新'))
  if (runners.has(bookId)) return Promise.reject(new Error('当前章节仍在处理中，请稍后检查更新'))
  const controller = new AbortController()
  const work = (async () => {
    const book = onlineBooks.value.find(b => b.bookId === bookId)
    if (!book) throw new Error('在线书籍不存在')
    const catalog = await discoverCatalog(book.catalogUrl, url => fetchOnlinePage(url, controller.signal))
    if (controller.signal.aborted) throw new DOMException('更新检查已取消', 'AbortError')
    // Keep the canonical identity, even when the source redirects its directory.
    catalog.catalogUrl = book.catalogUrl
    const count = book.chapters.length
    await addOnlineBook(catalog, { reveal: false })
    return Math.max(0, catalog.chapters.length - count)
  })().catch(async cause => {
    if (!controller.signal.aborted) await setState(bookId, { error: message(cause) })
    throw cause
  }).finally(() => checksInFlight.delete(bookId))
  checksInFlight.set(bookId, { controller, done: work })
  return work
}

export async function initializeOnlineLibrary() {
  if (initialized || !isTauri()) return
  initialized = true
  try {
    await refreshOnlineBooks()
    for (const book of onlineBooks.value) {
      if (book.state === 'downloading') void downloadOnlineBook(book.bookId)
      else if (book.catalogComplete === false && !book.error) {
        void import('./online-discovery').then(module => module.ensureCatalogComplete(book.bookId)).catch(() => {})
      }
    }
    const check = async () => {
      for (const book of [...onlineBooks.value]) {
        if (!book.autoUpdate || runners.has(book.bookId) || checksInFlight.has(book.bookId) || Date.now() - book.lastChecked < 30 * 60 * 1000) continue
        try {
          const count = await checkOnlineUpdates(book.bookId)
          const latest = onlineBooks.value.find(item => item.bookId === book.bookId)
          if (count && latest?.autoUpdate && latest.taskVisible !== false) void downloadOnlineBook(book.bookId)
        } catch { /* Persisted in task center. */ }
      }
    }
    void check()
    window.setInterval(() => void check(), 30 * 60 * 1000)
  } catch (cause) { initialized = false; throw cause }
}
