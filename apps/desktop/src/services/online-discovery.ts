import { reactive, shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { discoverCatalog, type DiscoveryProgress, type OnlineCatalog } from './online-parser'
import { addOnlineBook, fetchOnlinePage, onlineBooks, refreshOnlineBooks } from './online-library'

export interface OnlineDiscovery {
  url: string
  state: { catalog?: OnlineCatalog; progress: DiscoveryProgress; finished: boolean; cancelled: boolean; error: string; bookId?: string }
  done: Promise<void>
  adopt: () => Promise<string>
  setMetadata: (title: string, author: string) => void
  cancel: () => void
}
export const activeDiscovery = shallowRef<OnlineDiscovery>()
const adoptedJobs = new Map<string, OnlineDiscovery>()
const recovering = new Map<string, { controller: AbortController; done: Promise<void> }>()

export function beginOnlineDiscovery(url: string): OnlineDiscovery {
  const previous = activeDiscovery.value
  if (previous && !previous.state.bookId && !previous.state.finished) previous.cancel()
  const controller = new AbortController()
  const state = reactive<OnlineDiscovery['state']>({ progress: { pages: 0, chapters: 0, stage: 'fetching' }, finished: false, cancelled: false, error: '' })
  let adoption: Promise<string> | undefined
  let saving: Promise<unknown> = Promise.resolve()
  let metadata: { title: string; author: string } | undefined
  const withMetadata = (catalog: OnlineCatalog) => ({ ...catalog, ...metadata })
  const persist = (catalog: OnlineCatalog) => {
    const snapshot = { ...catalog, chapters: [...catalog.chapters] }
    saving = saving.then(async () => {
      if (!state.bookId || controller.signal.aborted) return
      await addOnlineBook(snapshot, { reveal: false })
      window.dispatchEvent(new CustomEvent('online-catalog-updated', { detail: { bookId: state.bookId } }))
    })
    return saving
  }
  const job: OnlineDiscovery = {
    url, state, done: Promise.resolve(),
    setMetadata: (title, author) => {
      if (!state.catalog || state.bookId) return
      metadata = { title: title.trim() || state.catalog.title, author: author.trim() }
      state.catalog = withMetadata(state.catalog)
    },
    adopt: () => {
      if (adoption) return adoption
      if (!state.catalog?.chapters.length) return Promise.reject(new Error('正在识别首批章节，请稍候'))
      adoption = (async () => {
        const snapshot = { ...state.catalog!, chapters: [...state.catalog!.chapters] }
        const id = await addOnlineBook(snapshot)
        state.bookId = id
        if (!state.finished) adoptedJobs.set(id, job)
        if (state.catalog && (state.catalog.chapters.length !== snapshot.chapters.length || state.catalog.complete !== snapshot.complete)) await persist(state.catalog)
        return id
      })()
      return adoption
    },
    cancel: () => { state.cancelled = true; controller.abort() }
  }
  job.done = (async () => {
    try {
      const result = await discoverCatalog(url, link => fetchOnlinePage(link, controller.signal), progress => { state.progress = progress }, async catalog => {
        if (controller.signal.aborted) throw new DOMException('解析已取消', 'AbortError')
        state.catalog = withMetadata(catalog)
        if (state.bookId) await persist(state.catalog)
      })
      if (controller.signal.aborted) return
      state.catalog = withMetadata({ ...result, complete: true })
      if (state.bookId) await persist(state.catalog)
    } catch (cause) {
      state.error = state.cancelled ? '' : cause instanceof Error ? cause.message : String(cause)
      if (state.bookId) await invoke('set_online_state', { bookId: state.bookId, error: state.cancelled ? '目录解析已取消，可在下载管理中检查更新以继续。' : state.error }).catch(() => {})
    } finally {
      state.finished = true
      if (state.bookId) adoptedJobs.delete(state.bookId)
    }
  })()
  activeDiscovery.value = job
  return job
}

export function ensureCatalogComplete(bookId: string): Promise<void> {
  if (recovering.has(bookId)) return recovering.get(bookId)!.done
  const controller = new AbortController()
  const work = (async () => {
    const job = adoptedJobs.get(bookId)
    if (job) await job.done
    else {
      const book = onlineBooks.value.find(book => book.bookId === bookId)
      if (!book || book.catalogComplete !== false) return
      const catalog = await discoverCatalog(book.catalogUrl, url => fetchOnlinePage(url, controller.signal))
      if (controller.signal.aborted) throw new DOMException('目录解析已取消', 'AbortError')
      catalog.catalogUrl = book.catalogUrl
      await addOnlineBook({ ...catalog, complete: true }, { reveal: false })
      window.dispatchEvent(new CustomEvent('online-catalog-updated', { detail: { bookId } }))
    }
    await refreshOnlineBooks()
    if (onlineBooks.value.find(book => book.bookId === bookId)?.catalogComplete === false) throw new Error('目录尚未完整，请在下载管理中重试检查更新')
  })().finally(() => recovering.delete(bookId))
  recovering.set(bookId, { controller, done: work })
  return work
}

export async function cancelCatalogForBook(bookId: string) {
  const job = adoptedJobs.get(bookId)
  if (job) { job.cancel(); await job.done }
  const recovery = recovering.get(bookId)
  if (recovery) { recovery.controller.abort(); await recovery.done.catch(() => {}) }
}
