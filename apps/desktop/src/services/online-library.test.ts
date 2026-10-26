// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn(), books: [] as any[], tauri: false, fetch: undefined as undefined | ((url: string) => Promise<any>) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => native.tauri }))
vi.mock('./desktop-library', () => ({ invalidateDesktopBookCache: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const content = '山风吹过长街，他沿着青石台阶走向灯火，路上遇见的每个人都有自己的故事。'.repeat(5)
const html = (number: number) => `<h1>第${number}章</h1><div id="content">${content}${number}</div>`
const book = (count = 3) => ({ bookId: 'book-1', title: '山河', catalogUrl: 'https://example.com/book', state: 'idle', autoUpdate: false, lastChecked: 0, error: '', chapters: Array.from({ length: count }, (_, i) => ({ number: i + 1, title: `第${i + 1}章`, url: `https://example.com/${i + 1}`, status: 'pending', error: '' })) })

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.removeItem('novel-library-search-engine')
  localStorage.removeItem('novel-library-search-novel-only')
  native.books = [book()]
  native.fetch = undefined
  native.tauri = false
  native.invoke.mockReset().mockImplementation(async (command: string, args: any) => {
    const target = native.books.find(b => b.bookId === args?.bookId)
    if (command === 'list_online_books') return structuredClone(native.books)
    if (command === 'set_online_state') {
      if (target && args.status) target.state = args.status
      if (target && args.autoUpdate !== undefined) target.autoUpdate = args.autoUpdate
      if (target && args.error !== undefined) target.error = args.error
      if (target && args.taskVisible !== undefined) target.taskVisible = args.taskVisible
      return
    }
    if (command === 'fetch_online_page') return native.fetch ? native.fetch(args.url) : { url: args.url, html: html(Number(args.url.split('/').at(-1))) }
    if (command === 'fetch_search_browser') return { url: args.url, html: '<div class="result" mu="https://example.com/book"><h3><a href="/link?url=token">天蚕土豆作品目录</a></h3><div class="c-abstract">小说章节</div></div>' }
    if (command === 'store_online_chapter') {
      const chapter = target.chapters.find((c: any) => c.number === args.number)
      chapter.status = args.error ? 'failed' : 'cached'
      chapter.error = args.error
      return
    }
    if (command === 'save_online_catalog') {
      const target = native.books[0]
      for (const [index, chapter] of args.input.chapters.entries()) {
        if (!target.chapters[index]) target.chapters.push({ ...chapter, number: index + 1, status: 'pending', error: '' })
      }
      target.lastChecked = Date.now()
      target.catalogComplete = args.input.complete !== false
      target.error = ''
      return target.bookId
    }
    throw new Error(`Unexpected command: ${command}`)
  })
})
afterEach(() => { vi.useRealTimers() })

describe('online library task lifecycle', () => {
  it('enables the novel filter by default and restores an explicit opt-out', async () => {
    expect((await import('./online-library')).onlineSearchSettings.novelOnly).toBe(true)
    vi.resetModules()
    localStorage.setItem('novel-library-search-novel-only', 'false')
    expect((await import('./online-library')).onlineSearchSettings.novelOnly).toBe(false)
  })
  it('keeps Brave offsets available after filtering and preserves raw order when disabled', async () => {
    const raw = [{ title: '山河视频', url: 'https://example.com/video', description: '' }, { title: '山河小说目录', url: 'https://example.com/book', description: '' }]
    native.invoke.mockResolvedValue(raw)
    const service = await import('./online-library')
    expect(await service.searchOnlineBooks('山河', 'test-key', 'brave', '0', { novelOnly: false })).toEqual({ hits: raw, next: '1' })
    expect(native.invoke).toHaveBeenLastCalledWith('search_online_books', { query: '山河', apiKey: 'test-key', offset: 0 })
    expect((await service.searchOnlineBooks('山河', 'test-key', 'brave', '9')).next).toBeUndefined()
    native.invoke.mockResolvedValue([raw[0]])
    expect(await service.searchOnlineBooks('山河', 'test-key', 'brave', '0')).toEqual({ hits: [], next: '1' })
  })
  it('falls back to Bing when the saved engine has been removed', async () => {
    localStorage.setItem('novel-library-search-engine', 'yandex')
    const service = await import('./online-library')
    expect(service.onlineSearchSettings.provider).toBe('bing')
  })
  it('automatically opens confirmation for the current page and continues after confirmation', async () => {
    native.tauri = true
    const implementation = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'fetch_search_browser' && !args.interactive) throw '该引擎需要网页确认，请打开搜索窗口后继续。'
      if (command === 'fetch_search_browser') return { url: args.url, html: '<li class="b_algo"><h2><a href="https://example.com/book">山河小说目录</a></h2></li>' }
      return implementation(command, args)
    })
    const service = await import('./online-library')
    const phase = vi.fn()
    const cursor = 'https://www.bing.com/search?q=山河&first=11'
    const result = await service.searchOnlineBooks('山河', '', 'bing', cursor, { onBrowser: phase })
    expect(result.hits[0].title).toBe('山河小说目录')
    expect(phase.mock.calls).toEqual([[false], [true]])
    expect(native.invoke).toHaveBeenLastCalledWith('fetch_search_browser', { url: cursor, interactive: true })
  })
  it('keeps cancellation as a cancellation instead of reopening the confirmation window', async () => {
    native.tauri = true
    native.invoke.mockRejectedValue('网页搜索已取消')
    const service = await import('./online-library')
    await expect(service.searchOnlineBooks('山河', '', 'bing', 'https://www.bing.com/search?q=山河&first=11')).rejects.toBe('网页搜索已取消')
    expect(native.invoke).toHaveBeenCalledOnce()
  })
  it('cancels an update scan before removing a task so a late response cannot recreate it', async () => {
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    let release!: () => void
    native.fetch = url => new Promise(resolve => { release = () => resolve({ url, html: '<h1>山河</h1><div id="list"><a href="/1">第1章</a><a href="/2">第2章</a></div>' }) })
    const check = service.checkOnlineUpdates('book-1').catch(cause => cause)
    await vi.advanceTimersByTimeAsync(1)
    const removal = service.removeOnlineTask('book-1')
    await vi.runAllTimersAsync()
    await removal
    release()
    await vi.runAllTimersAsync()
    expect((await check).name).toBe('AbortError')
    expect(native.books[0]).toMatchObject({ taskVisible: false, autoUpdate: false, state: 'cancelled' })
    expect(native.invoke.mock.calls.some(([command]) => command === 'save_online_catalog')).toBe(false)
  })
  it('cancels incomplete directory recovery before deletion and discards its late result', async () => {
    native.books[0].catalogComplete = false
    const service = await import('./online-library')
    const discovery = await import('./online-discovery')
    await service.refreshOnlineBooks()
    let release!: () => void
    native.fetch = url => new Promise(resolve => { release = () => resolve({ url, html: '<h1>山河</h1><div id="list"><a href="/1">第1章</a><a href="/2">第2章</a></div>' }) })
    const recovery = discovery.ensureCatalogComplete('book-1').catch(cause => cause)
    await vi.advanceTimersByTimeAsync(1)
    const cancel = discovery.cancelCatalogForBook('book-1')
    await vi.runAllTimersAsync()
    await cancel
    release()
    await vi.runAllTimersAsync()
    expect((await recovery).name).toBe('AbortError')
    expect(native.invoke.mock.calls.some(([command]) => command === 'save_online_catalog')).toBe(false)
  })
  it('retries a catalog stopped at sixty pages and downloads only its uncached chapters', async () => {
    native.books = [{ ...book(120), catalogComplete: false, state: 'failed', error: '目录超过 60 页，已停止继续解析' }]
    for (const chapter of native.books[0].chapters) chapter.status = 'cached'
    native.fetch = async url => {
      const address = new URL(url)
      if (address.pathname !== '/book') return { url, html: html(Number(address.pathname.slice(1))) }
      const page = Number(address.searchParams.get('page') || 1)
      const numbers = [page * 2 - 1, page * 2]
      return { url, html: '<h1>山河</h1><div id="list">' + numbers.map(number => `<a href="/${number}">第${number}章</a>`).join('')
        + '</div>' + (page < 61 ? `<a href="/book?page=${page + 1}">下一页</a>` : '') }
    }
    const service = await import('./online-library')
    await import('./online-discovery')
    await service.refreshOnlineBooks()
    const task = service.downloadOnlineBook('book-1')
    await vi.runAllTimersAsync()
    await task
    expect(native.books[0]).toMatchObject({ state: 'complete', catalogComplete: true, error: '' })
    expect(native.books[0].chapters).toHaveLength(122)
    expect(native.books[0].chapters.every((chapter: any) => chapter.status === 'cached')).toBe(true)
    const requested = native.invoke.mock.calls.filter(([command]) => command === 'fetch_online_page').map(([, args]) => new URL(args.url))
    expect(requested.filter(url => url.pathname === '/book')).toHaveLength(61)
    expect(requested.filter(url => url.pathname !== '/book').map(url => url.pathname)).toEqual(['/121', '/122'])
  })
  it('loads a browser session after a direct Baidu request requires verification', async () => {
    native.tauri = true
    native.fetch = async url => ({ url, html: '<title>百度安全验证</title>' })
    const service = await import('./online-library')
    const phase = vi.fn()
    const request = service.searchOnlineBooks('天蚕土豆', '', 'baidu', undefined, { onBrowser: phase })
    await vi.runAllTimersAsync()
    expect((await request).hits).toHaveLength(1)
    expect(phase).toHaveBeenCalledOnce()
    expect(native.invoke).toHaveBeenCalledWith('fetch_search_browser', { url: 'https://www.baidu.com/s?wd=%E5%A4%A9%E8%9A%95%E5%9C%9F%E8%B1%86', interactive: false })
  })
  it('uses rendered Google search and parses the official Hong Kong redirect', async () => {
    native.tauri = true
    native.invoke.mockResolvedValue({ url: 'https://www.google.com.hk/search?q=山河', html: '<div class="g"><a href="https://example.com/book"><h3>山河小说</h3></a></div><a id="pnnext" href="/search?q=山河&start=10">Next</a>' })
    const service = await import('./online-library')
    const result = await service.searchOnlineBooks('山河', '', 'google')
    expect(result.hits[0].title).toBe('山河小说')
    expect(result.next).toContain('start=10')
    expect(native.invoke).toHaveBeenCalledOnce()
    expect(native.invoke).toHaveBeenCalledWith('fetch_search_browser', { url: 'https://www.google.com/search?q=%E5%B1%B1%E6%B2%B3', interactive: false })
  })
  it('renders an incomplete search response before treating it as no results', async () => {
    native.tauri = true
    native.fetch = async url => ({ url, html: '<div id="app"></div>' })
    const previous = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation(async (command, args) => command === 'fetch_search_browser'
      ? { url: args.url, html: '<div class="vrwrap"><h3><a href="https://example.com/book">山河小说目录</a></h3></div>' }
      : previous(command, args))
    const service = await import('./online-library')
    const request = service.searchOnlineBooks('山河', '', 'sogou')
    await vi.runAllTimersAsync()
    expect((await request).hits[0].title).toBe('山河小说目录')
    expect(native.invoke).toHaveBeenCalledWith('fetch_search_browser', { url: 'https://www.sogou.com/web?query=%E5%B1%B1%E6%B2%B3', interactive: false })
  })
  it('resumes the browser confirmation window without repeating the direct request', async () => {
    const service = await import('./online-library')
    const result = await service.searchOnlineBooks('天蚕土豆', '', 'baidu', undefined, { browser: true })
    expect(result.hits[0].title).toContain('天蚕土豆')
    expect(native.invoke.mock.calls.some(([command]) => command === 'fetch_online_page')).toBe(false)
    expect(native.invoke).toHaveBeenCalledWith('fetch_search_browser', expect.objectContaining({ interactive: true }))
  })
  it('deduplicates simultaneous reader/download requests and persists the result', async () => {
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    const tasks = [service.ensureOnlineChapter('book-1', 1), service.ensureOnlineChapter('book-1', 1)]
    await vi.runAllTimersAsync()
    await Promise.all(tasks)
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_page')).toHaveLength(1)
    expect(native.books[0].chapters[0].status).toBe('cached')
  })
  it('pauses after the in-flight chapter, then resumes without re-downloading cached chapters', async () => {
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    let release!: (value: unknown) => void
    native.fetch = url => new Promise(resolve => { release = () => resolve({ url, html: html(1) }) })
    const task = service.downloadOnlineBook('book-1')
    await vi.advanceTimersByTimeAsync(1)
    await service.pauseOnlineBook('book-1')
    release(undefined)
    await vi.runAllTimersAsync()
    await task
    expect(native.books[0].state).toBe('paused')
    expect(native.books[0].chapters.filter((c: any) => c.status === 'cached')).toHaveLength(1)
    native.fetch = undefined
    const resume = service.downloadOnlineBook('book-1')
    await vi.runAllTimersAsync()
    await resume
    expect(native.books[0].state).toBe('complete')
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_page')).toHaveLength(3)
  })
  it('downloads different sites concurrently and resumes both without re-fetching cached chapters', async () => {
    native.books.push({ ...book(2), bookId: 'book-2', catalogUrl: 'https://other.example/book', chapters: book(2).chapters.map(chapter => ({ ...chapter, url: chapter.url.replace('example.com', 'other.example') })) })
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    const releases: (() => void)[] = []
    native.fetch = url => new Promise(resolve => releases.push(() => resolve({ url, html: html(1) })))
    const jobs = [service.downloadOnlineBook('book-1'), service.downloadOnlineBook('book-2')]
    await vi.advanceTimersByTimeAsync(0)
    expect(releases).toHaveLength(2)
    await service.pauseOnlineBook('book-1'); await service.pauseOnlineBook('book-2')
    for (const release of releases) release()
    await vi.runAllTimersAsync(); await Promise.all(jobs)
    expect(native.books.map(book => book.chapters.filter((chapter: any) => chapter.status === 'cached').length)).toEqual([1, 1])
    native.fetch = undefined
    const resumed = [service.downloadOnlineBook('book-1'), service.downloadOnlineBook('book-2')]
    await vi.runAllTimersAsync(); await Promise.all(resumed)
    expect(native.books.map(book => book.state)).toEqual(['complete', 'complete'])
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_page')).toHaveLength(5)
  })
  it('removes a paused background request from the host queue without marking it failed', async () => {
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    let release!: () => void
    native.fetch = url => new Promise(resolve => { release = () => resolve({ url, html: html(99) }) })
    const busy = service.fetchOnlinePage('https://example.com/busy')
    const download = service.downloadOnlineBook('book-1')
    await vi.advanceTimersByTimeAsync(0)
    await service.pauseOnlineBook('book-1')
    await vi.advanceTimersByTimeAsync(0); await download
    expect(native.books[0].state).toBe('paused')
    expect(native.books[0].chapters.every((chapter: any) => chapter.status === 'pending')).toBe(true)
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_page')).toHaveLength(1)
    release(); await vi.runAllTimersAsync(); await busy
  })
  it('prioritizes the reader over a queued download and shares the chapter already requested by it', async () => {
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    let release!: () => void
    const starts: string[] = []
    native.fetch = url => {
      starts.push(url)
      return url.endsWith('/busy') ? new Promise(resolve => { release = () => resolve({ url, html: html(99) }) }) : Promise.resolve({ url, html: html(Number(url.split('/').at(-1))) })
    }
    const busy = service.fetchOnlinePage('https://example.com/busy')
    const download = service.downloadOnlineBook('book-1')
    await vi.advanceTimersByTimeAsync(0)
    const reading = service.ensureOnlineChapter('book-1', 3)
    const shared = service.ensureOnlineChapter('book-1', 1)
    release(); await vi.runAllTimersAsync(); await Promise.all([busy, download, reading, shared])
    expect(starts).toEqual(['https://example.com/busy', 'https://example.com/1', 'https://example.com/3', 'https://example.com/2'])
    expect(native.books[0].state).toBe('complete')
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'store_online_chapter')).toHaveLength(3)
  })
  it('retries temporary errors with backoff and stores the chapter only once', async () => {
    const service = await import('./online-library'), starts: number[] = []
    await service.refreshOnlineBooks()
    native.fetch = async url => {
      starts.push(Date.now())
      if (starts.length < 3) throw new Error('网站返回 HTTP 500')
      return { url, html: html(1) }
    }
    const task = service.ensureOnlineChapter('book-1', 1)
    await vi.runAllTimersAsync(); await task
    expect(starts.slice(1).map((time, index) => time - starts[index]!)).toEqual([1500, 3000])
    expect(native.books[0].chapters[0].status).toBe('cached')
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'store_online_chapter')).toHaveLength(1)
  })
  it('bounds consecutive failures and leaves unattempted chapters pending', async () => {
    native.books = [book(8)]
    native.fetch = async url => ({ url, html: '<h1>无正文</h1>' })
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    const task = service.downloadOnlineBook('book-1')
    await vi.runAllTimersAsync()
    await task
    expect(native.books[0].state).toBe('failed')
    expect(native.books[0].chapters.filter((c: any) => c.status === 'failed')).toHaveLength(5)
    expect(native.books[0].chapters.filter((c: any) => c.status === 'pending')).toHaveLength(3)
  })
  it('pauses after closing verification instead of reopening it for subsequent chapters', async () => {
    native.tauri = true
    native.fetch = async () => { throw new Error('网站返回 HTTP 403') }
    const implementation = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'fetch_online_browser') throw '网页验证已取消'
      return implementation(command, args)
    })
    const service = await import('./online-library')
    await service.refreshOnlineBooks()
    const task = service.downloadOnlineBook('book-1')
    await vi.runAllTimersAsync(); await task
    expect(native.books[0].state).toBe('paused')
    expect(native.books[0].chapters.every((chapter: any) => chapter.status === 'pending')).toBe(true)
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_browser')).toHaveLength(1)
  })
  it('cancels without deleting cached content', async () => {
    const service = await import('./online-library')
    native.books[0].chapters[0].status = 'cached'
    await service.refreshOnlineBooks()
    await service.pauseOnlineBook('book-1', true)
    expect(native.books[0].state).toBe('cancelled')
    expect(native.books[0].chapters[0].status).toBe('cached')
  })
  it('removes a task without deleting cached chapters and can restore it', async () => {
    const service = await import('./online-library')
    native.books[0].chapters[0].status = 'cached'
    native.books[0].autoUpdate = true
    await service.refreshOnlineBooks()
    await service.removeOnlineTask('book-1')
    expect(native.books[0].taskVisible).toBe(false)
    expect(native.books[0].autoUpdate).toBe(false)
    expect(native.books[0].chapters[0].status).toBe('cached')
    await service.restoreOnlineTask('book-1')
    expect(native.books[0].taskVisible).toBe(true)
  })
  it('appends update results to the existing canonical source and supports tracking opt-in', async () => {
    const service = await import('./online-library')
    native.books[0].chapters[0].status = 'cached'
    await service.refreshOnlineBooks()
    native.fetch = async url => ({ url, html: `<h1>山河</h1><ul>${[1, 2, 3, 4].map(n => `<li><a href="/${n}">第${n}章</a></li>`).join('')}</ul>` })
    const check = service.checkOnlineUpdates('book-1')
    await vi.runAllTimersAsync()
    expect(await check).toBe(1)
    expect(native.books[0].chapters[0].status).toBe('cached')
    expect(native.books[0].chapters[3].status).toBe('pending')
    await service.toggleOnlineUpdates('book-1', true)
    expect(native.books[0].autoUpdate).toBe(true)
  })
})
