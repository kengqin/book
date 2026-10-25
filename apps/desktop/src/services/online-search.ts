import { httpUrl, type FetchPage } from './online-parser'

export type SearchEngine = 'bing' | 'baidu' | 'google' | 'sogou' | 'so360' | 'duckduckgo' | 'brave'
export interface OnlineSearchHit { title: string; url: string; description: string }
export interface SearchPage { hits: OnlineSearchHit[]; next?: string }
export const SEARCH_BATCH_SIZE = 10

export async function loadSearchBatch(fetchPage: (cursor?: string) => Promise<SearchPage>, options: { initial?: boolean; cursor?: string; pending?: OnlineSearchHit[] } = {}) {
  const hits: OnlineSearchHit[] = []
  const pending: OnlineSearchHit[] = []
  const accept = (items: OnlineSearchHit[]) => {
    for (const hit of items) {
      if (hits.length < SEARCH_BATCH_SIZE) hits.push(hit)
      else pending.push(hit)
    }
  }
  accept(options.pending || [])
  let next = options.cursor
  let warning = ''
  let initial = options.initial === true
  const visited = new Set<string>()
  // Filtering can leave fewer results than requested.
  // Bound the extra requests while preserving overflow for the next user action.
  for (let count = 0; count < 3 && hits.length < SEARCH_BATCH_SIZE && (initial || next); count++) {
    const cursor = initial ? undefined : next
    initial = false
    if (visited.has(cursor || '')) { next = undefined; break }
    visited.add(cursor || '')
    try {
      const page = await fetchPage(cursor)
      next = page.next
      accept(page.hits)
    } catch (cause) {
      if (!hits.length || /已取消/u.test(cause instanceof Error ? cause.message : String(cause))) throw cause
      warning = cause instanceof Error ? cause.message : String(cause)
      next = cursor
      break
    }
  }
  return { hits, pending, next, warning }
}
export const searchEngineOptions = [{ value: 'bing', label: '必应' }, { value: 'baidu', label: '百度' }, { value: 'google', label: 'Google' }, { value: 'sogou', label: '搜狗' }, { value: 'so360', label: '360 搜索' }, { value: 'duckduckgo', label: 'DuckDuckGo' }, { value: 'brave', label: 'Brave Search' }]
const clean = (value: string | null | undefined) => (value || '').replace(/\s+/gu, ' ').trim()

export function searchBrowserUrl(engine: string, query: string) {
  const q = encodeURIComponent(query)
  if (engine === 'baidu') return `https://www.baidu.com/s?wd=${q}`
  if (engine === 'google') return `https://www.google.com/search?q=${q}`
  if (engine === 'sogou') return `https://www.sogou.com/web?query=${q}`
  if (engine === 'so360') return `https://www.so.com/s?q=${q}`
  if (engine === 'duckduckgo') return `https://duckduckgo.com/?q=${q}`
  if (engine === 'brave') return `https://search.brave.com/search?q=${q}`
  return `https://www.bing.com/search?q=${q}`
}
export function novelSearchQuery(query: string) { return query.trim() }

function resultUrl(value: string, base: string) {
  let url = httpUrl(value, base)
  if (!url) return
  const parsed = new URL(url)
  if (/^(?:www\.)?google\.(?:com|com\.hk)$/u.test(parsed.hostname) && parsed.pathname === '/url') url = httpUrl(parsed.searchParams.get('q') || parsed.searchParams.get('url') || '')
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.searchParams.has('uddg')) url = httpUrl(parsed.searchParams.get('uddg')!)
  if (parsed.hostname.endsWith('bing.com') && parsed.pathname === '/ck/a') {
    const encoded = parsed.searchParams.get('u')
    if (encoded?.startsWith('a1')) {
      try {
        const raw = encoded.slice(2).replace(/-/gu, '+').replace(/_/gu, '/')
        url = httpUrl(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))))
      } catch { return }
    }
  }
  return url
}

export function isNovelSearchHit(hit: OnlineSearchHit) {
    const reading = /章节|章節|章目|目录|目錄|全文阅读|全文閱讀|在线阅读|小說閱讀|小说阅读/u.test(hit.title)
    if (/漫画|漫畫|动漫|動畫|动画|视频|視頻|电视剧|電視劇|手游|游戏下载/u.test(hit.title) && !reading) return false
    return /小说|小說|章节|章節|章目|目录|目錄|全文|阅读|閱讀|文学|文學|作家|著作|书库|書庫|书阁|書閣|书屋|書屋|书城|書城|笔趣|筆趣/u.test(`${hit.title} ${hit.description}`)
}
export function filterNovelHits(hits: OnlineSearchHit[], novelOnly = true) {
  return novelOnly ? hits.filter(isNovelSearchHit) : hits
}

export function parseSearchPage(html: string, url: string, engine: SearchEngine, novelOnly = true): SearchPage {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = doc.body.textContent || ''
  if (/安全验证|人机验证|Just a moment|Access denied|验证访问|Robot Check/iu.test(doc.title) || doc.querySelector('#challenge-form,form[action*="anomaly.js"],form[action*="/sorry"],.g-recaptcha') || /unusual traffic from your computer|我们的系统检测到|此验证码用于确认/iu.test(text)) {
    throw new Error(`${searchEngineOptions.find(option => option.value === engine)?.label}要求网页验证，请切换搜索引擎，或在浏览器中打开搜索。`)
  }
  if (engine === 'google' && !doc.querySelector('h3') && /Please click here if you are not redirected|enablejs/iu.test(text + html.slice(0, 3000))) throw new Error('Google要求浏览器加载页面，请稍后重试。')
  const selectors: Record<string, string> = {
    bing: '.b_algo h2 a[href]', baidu: '.result h3 a[href],.c-container h3 a[href]',
    google: 'a[href]:has(h3)',
    sogou: '.vrwrap h3 a[href],.rb h3 a[href],.vr-title a[href]',
    so360: '.res-list h3 a[href],.result h3 a[href],.res-title a[href]',
    duckduckgo: '.result__a[href],[data-testid="result-title-a"][href]'
  }
  const selector = selectors[engine] || '.result__a[href]'
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>(selector))
  const offset = engine === 'duckduckgo' ? Number(new URL(url).hash.match(/^#reader-offset=(\d+)$/u)?.[1] || 0) : 0
  const hits = anchors.slice(offset).flatMap(anchor => {
    const container = anchor.closest('.b_algo,.result,.c-container,.web-result,.g,.MjjYud,.vrwrap,.rb,.res-list,article[data-testid="result"]')
    const target = resultUrl(container?.getAttribute('mu') || anchor.getAttribute('data-mdurl') || anchor.getAttribute('href') || '', url)
    const title = clean(anchor.querySelector('h3,h2')?.textContent || anchor.textContent)
    if (!target || !title) return []
    const description = clean(container?.querySelector('.b_caption p,.c-abstract,.result__snippet,[data-result="snippet"],[data-testid="result-snippet"],.VwiC3b,.str_info,.res-desc,p')?.textContent)
    return [{ title, url: target, description }]
  })
  const nextAnchor = doc.querySelector('a.sb_pagN[href],a#pnnext[href],a[rel="next"][href],a#sogou_next[href],a#next[href]') || Array.from(doc.querySelectorAll('a[href]')).find(a => /^(?:下一页|下一頁|Next|Next page)[\s>»›→]*$/iu.test(clean(a.getAttribute('aria-label') || a.getAttribute('title') || a.textContent)))
  let next = nextAnchor ? httpUrl(nextAnchor.getAttribute('href') || '', url) : undefined
  if (!next && engine === 'baidu') {
    const current = Number(new URL(url).searchParams.get('pn') || 0)
    const pageLinks = Array.from(doc.querySelectorAll<HTMLAnchorElement>('#page a[href],.page-inner a[href],[class*="page"] a[href]')).map(anchor => httpUrl(anchor.getAttribute('href') || '', url)).filter((target): target is string => Boolean(target) && new URL(target!).searchParams.has('pn'))
    next = pageLinks.find(target => Number(new URL(target).searchParams.get('pn')) > current)
    const numberedPager = pageLinks.length || /\d/u.test(doc.querySelector('#page,.page-inner')?.textContent || '')
    // Some Baidu layouts render the pager later. A result page can still be
    // continued by its offset, but an explicit last page must remain the end.
    if (!next && anchors.length && !numberedPager) {
      const target = new URL(url)
      target.searchParams.set('pn', String(current + 10))
      next = target.href
    }
  }
  if (!next && engine === 'sogou' && anchors.length && !/\d/u.test(doc.querySelector('#pagebar,.pagenum')?.textContent || '')) {
    const target = new URL(url)
    target.searchParams.set('page', String(Number(target.searchParams.get('page') || 1) + 1))
    next = target.href
  }
  if (engine === 'duckduckgo') {
    const form = Array.from(doc.querySelectorAll('form')).find(f => /next|下一页/iu.test(f.textContent || '') || f.querySelector('input[value="Next"]'))
    if (form) {
      const target = new URL(form.getAttribute('action') || url, url)
      form.querySelectorAll<HTMLInputElement>('input[name]').forEach(input => target.searchParams.set(input.name, input.value))
      next = httpUrl(target.href)
    }
    if (doc.querySelector('button#more-results') && anchors.length > offset) {
      const target = new URL(url)
      target.hash = `reader-offset=${anchors.length}`
      next = target.href
    }
  }
  if (next && new URL(next).hostname !== new URL(url).hostname) next = undefined
  if (next && engine === 'bing') {
    // Session tracking parameters can cause Bing to serve page one for later offsets.
    const target = new URL(next)
    const cleanTarget = new URL(target.pathname, target.origin)
    for (const key of ['q', 'first']) {
      const value = target.searchParams.get(key)
      if (value !== null) cleanTarget.searchParams.set(key, value)
    }
    next = cleanTarget.href
  }
  if (next && engine === 'baidu') {
    const target = new URL(next)
    const cleanTarget = new URL(target.pathname, target.origin)
    for (const key of ['wd', 'pn', 'ie']) {
      const value = target.searchParams.get(key)
      if (value !== null) cleanTarget.searchParams.set(key, value)
    }
    next = cleanTarget.href
  }
  if (next && engine === 'sogou') {
    const target = new URL(next)
    const cleanTarget = new URL(target.pathname, target.origin)
    for (const key of ['query', 'page', 'ie']) {
      const value = target.searchParams.get(key)
      if (value !== null) cleanTarget.searchParams.set(key, value)
    }
    next = cleanTarget.href
  }
  return { hits: filterNovelHits(hits, novelOnly), next }
}

export async function searchPublicBooks(engine: Exclude<SearchEngine, 'brave'>, query: string, fetchPage: FetchPage, cursor?: string, novelOnly = true): Promise<SearchPage> {
  const initial = engine === 'duckduckgo' ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` : searchBrowserUrl(engine, novelSearchQuery(query))
  const page = await fetchPage(cursor || initial)
  const parsed = parseSearchPage(page.html, page.url, engine, novelOnly)
  if (parsed.hits.length || parsed.next || cursor || engine !== 'bing') return parsed
  // The HTML endpoint may be unavailable while the public RSS endpoint works.
  const rss = await fetchPage(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`)
  const doc = new DOMParser().parseFromString(rss.html, 'text/xml')
  const hits = Array.from(doc.querySelectorAll('item')).flatMap(item => {
    const url = httpUrl(item.querySelector('link')?.textContent || '')
    return url ? [{ title: clean(item.querySelector('title')?.textContent), url, description: clean(item.querySelector('description')?.textContent) }] : []
  })
  return { hits: filterNovelHits(hits, novelOnly) }
}
