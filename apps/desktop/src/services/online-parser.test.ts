// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { discoverCatalog, extractChapter, httpUrl, parseOnlinePage } from './online-parser'

const paragraph = '山风吹过长街，他沿着青石台阶向前走去。远处的灯火照亮了归途，也照亮了记忆中那座安静的城。'
const body = paragraph.repeat(4)
const chapter = (title: string, text = body, next = '') => `<h1>${title}</h1><div id="content"><p>${text}</p><script>evil()</script><div class="ad">垃圾广告</div></div>${next ? `<a href="${next}">下一页</a>` : ''}`
const directory = (numbers: number[], next = '') => `<h1>山河</h1><meta property="og:novel:author" content="某作者"><div id="list">${numbers.map(n => `<dd><a href="/${n}.html">第${n}章 远行</a></dd>`).join('')}</div>${next ? `<a href="${next}">下一页</a>` : ''}`

describe('automatic online parser', () => {
  it('normalizes relative links and rejects executable or credential-bearing URLs', () => {
    expect(httpUrl('../1.html#top', 'https://example.com/book/index')).toBe('https://example.com/1.html')
    for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://u:p@example.com', 'http://example.com:8000']) expect(httpUrl(url)).toBeUndefined()
  })
  it('extracts a deduplicated ordered directory without recommendations', () => {
    const parsed = parseOnlinePage(directory([3, 2, 1]) + '<aside><a href="/bad">第999章 广告</a></aside>', 'https://example.com/book')
    expect(parsed.chapters.map(c => c.title)).toEqual(['第1章 远行','第2章 远行','第3章 远行'])
    expect(parsed.author).toBe('某作者')
    expect(parsed.content).toBe('')
  })
  it('strips scripts and advertising without carrying executable HTML into the reader', () => {
    const parsed = parseOnlinePage(chapter('第1章 山河'), 'https://example.com/1')
    expect(parsed.content).toBe(body)
    expect(parsed.content).not.toMatch(/evil|垃圾|<script>/)
  })
  it('ignores the site logo when identifying the chapter heading', () => {
    const parsed = parseOnlinePage('<div class="header"><h1 class="logo">网站名</h1></div>' + chapter('第1章 山河'), 'https://example.com/1')
    expect(parsed.title).toBe('第1章 山河')
  })
  it('follows a chapter backlink to a paginated full directory', async () => {
    const pages: Record<string, string> = {
      'https://example.com/1.html': chapter('第1章 山河') + '<a href="/book">返回目录</a>',
      'https://example.com/book': directory([1, 2], '/book?page=2'),
      'https://example.com/book?page=2': directory([3, 4])
    }
    const fetch = vi.fn(async (url: string) => ({ url, html: pages[url] }))
    const book = await discoverCatalog('https://example.com/1.html', fetch)
    expect(book.chapters).toHaveLength(4)
    expect(book.catalogUrl).toBe('https://example.com/book')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('imports single chapters with an explicit incomplete-directory warning', async () => {
    const result = await discoverCatalog('https://example.com/1', async url => ({ url, html: chapter('第1章 山河') }))
    expect(result.chapters).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
  })
  it('starts at the first directory page when search lands on a middle page', async () => {
    const select = '<select><option value="/book">1 - 2章</option><option value="/book/2">3 - 4章</option></select>'
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/2') ? directory([3,4]) + select : directory([1,2], '/book/2') + select }))
    const result = await discoverCatalog('https://example.com/book/2', fetch)
    expect(result.catalogUrl).toBe('https://example.com/book')
    expect(result.chapters.map(c => c.title)).toEqual(['第1章 远行','第2章 远行','第3章 远行','第4章 远行'])
  })
  it('collects a long catalog beyond sixty pages instead of stopping at 1200 chapters', async () => {
    const total = 1562
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') || 1)
      const start = (page - 1) * 20 + 1
      const numbers = Array.from({ length: Math.min(20, total - start + 1) }, (_, index) => start + index)
      return { url, html: directory(numbers, numbers.at(-1)! < total ? `/book?page=${page + 1}` : '') }
    })
    const partial = vi.fn()
    const result = await discoverCatalog('https://example.com/book', fetch, undefined, partial)
    expect(result.complete).toBe(true)
    expect(result.chapters).toHaveLength(total)
    expect(result.chapters.at(-1)?.title).toBe('第1562章 远行')
    expect(fetch).toHaveBeenCalledTimes(79)
    expect(partial.mock.calls[59][0]).toMatchObject({ complete: false, chapters: expect.any(Array) })
    expect(partial.mock.calls[59][0].chapters).toHaveLength(1200)
    expect(partial.mock.calls.at(-1)?.[0].complete).toBe(true)
  }, 10000)
  it('keeps a lone unnumbered chapter on the final catalog page', async () => {
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/last')
      ? '<h1>山河</h1><div class="catalog"><ul><li><a href="/3.html">新的旅程</a></li></ul></div>'
      : directory([1, 2], '/last') }))
    const result = await discoverCatalog('https://example.com/book', fetch)
    expect(result.complete).toBe(true)
    expect(result.chapters.map(chapter => chapter.title)).toEqual(['第1章 远行', '第2章 远行', '新的旅程'])
  })
  it('deduplicates overlapping catalog pages while accepting their new chapters', async () => {
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/page2') ? directory([2, 3]) : directory([1, 2], '/page2') }))
    const result = await discoverCatalog('https://example.com/book', fetch)
    expect(result.complete).toBe(true)
    expect(result.chapters.map(chapter => chapter.title)).toEqual(['第1章 远行', '第2章 远行', '第3章 远行'])
  })
  it('stops repeated directory content even when every next-page URL is different', async () => {
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') || 1)
      return { url, html: directory(page === 1 ? [1, 2] : [3, 4], `/book?page=${page + 1}`) }
    })
    const partial = vi.fn()
    await expect(discoverCatalog('https://example.com/book', fetch, undefined, partial)).rejects.toThrow('未发现新章节')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(partial).toHaveBeenCalledTimes(2)
    expect(partial.mock.calls.at(-1)?.[0]).toMatchObject({ complete: false })
    expect(partial.mock.calls.at(-1)?.[0].chapters).toHaveLength(4)
  })
  it('detects a redirect to an already visited catalog page', async () => {
    const fetch = vi.fn(async (url: string) => ({ url: 'https://example.com/book', html: url.endsWith('/page2') ? directory([3, 4], '/page3') : directory([1, 2], '/page2') }))
    await expect(discoverCatalog('https://example.com/book', fetch)).rejects.toThrow('循环')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('bounds entry-page redirects that never reach a catalog', async () => {
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).pathname.split('/').at(-1))
      return { url, html: `<h1>山河</h1><a href="/entry/${page + 1}">开始阅读</a>` }
    })
    await expect(discoverCatalog('https://example.com/entry/1', fetch)).rejects.toThrow('目录入口跳转过多')
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(60)
  })
  it('exposes usable first chapters before the remaining directory has loaded', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const partial = vi.fn()
    const progress = vi.fn()
    const task = discoverCatalog('https://example.com/book', async url => {
      if (url.endsWith('/page2')) await gate
      return { url, html: url.endsWith('/page2') ? directory([3,4]) : directory([1,2], '/page2') }
    }, progress, partial)
    await vi.waitFor(() => expect(partial).toHaveBeenCalledTimes(1))
    expect(partial.mock.calls[0][0]).toMatchObject({ complete: false, chapters: [{ title: '第1章 远行' }, { title: '第2章 远行' }] })
    release()
    expect((await task).complete).toBe(true)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ chapters: 4 }))
  })
  it('merges chapter pages but never follows the next chapter link', async () => {
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/1') ? chapter('第1章 山河 (1/2)', body, '/1_2') : chapter('第1章 山河 (2/2)', body + '第二页') + '<a href="/2">下一章</a>' }))
    expect(await extractChapter('https://example.com/1', fetch)).toBe(body + '\n\n' + body + '第二页')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('merges a short final page only when it has an explicit body and the same chapter title', async () => {
    const end = '新的世界，我来了！希望这个故事，能再陪伴大家三年！'
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/1') ? chapter('第0章 感言', body, '/1_2') : chapter('第0章 感言', end) }))
    expect(await extractChapter('https://example.com/1', fetch)).toBe(body + '\n\n' + end)
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第0章 感言', end) }))).rejects.toThrow('正文')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: url.endsWith('/1') ? chapter('第0章 感言', body, '/1_2') : chapter('第1章 初见', end) }))).rejects.toThrow('标题不同')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: url.endsWith('/1') ? chapter('第0章 感言', body, '/1_2') : chapter('', end) }))).rejects.toThrow('短分页')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: url.endsWith('/1') ? chapter('第0章 感言', body, '/1_2') : '<h1>第0章 感言</h1><div>' + end + '</div>' }))).rejects.toThrow('正文')
  })
  it('does not save cross-chapter, repeated, looping or incomplete pages as successful', async () => {
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter(url.endsWith('/1') ? '第1章' : '第2章', body, '/2') }))).rejects.toThrow('标题不同')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第1章', body, '/2') }))).rejects.toThrow('重复')
    await expect(discoverCatalog('https://example.com/book', async url => ({ url, html: directory([1,2], url.endsWith('/book') ? '/page2' : '/book') }))).rejects.toThrow('循环')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: '<h1>正文</h1><div id="content"></div>' }))).rejects.toThrow('正文')
  })
  it('uses the directory to distinguish a mislabeled next chapter from chapter pagination', async () => {
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/1')
      ? chapter('第1章 山河 [1/2页]', body, '/1_2')
      : chapter('第1章 山河 [2/2页]', body + '第二页', '/2') }))
    const urls = new Set(['https://example.com/1', 'https://example.com/2'])
    expect(await extractChapter('https://example.com/1', fetch, urls)).toBe(body + '\n\n' + body + '第二页')
    expect(fetch).toHaveBeenCalledTimes(2)
    const single = vi.fn(async (url: string) => ({ url, html: chapter('第0章 感言', body, '/2') }))
    expect(await extractChapter('https://example.com/0', single, urls)).toBe(body)
    expect(single).toHaveBeenCalledOnce()
  })
  it('rejects verification pages', () => {
    expect(() => parseOnlinePage('<h1>安全检查</h1><p>请完成人机验证</p>', 'https://example.com')).toThrow('验证')
  })
  it('recognizes chapter rows by structure while preserving arbitrary titles', () => {
    const titles = ['学院篇（01）初见', '没有编号的相逢', '作者的话', '终点之后']
    const html = '<h1>山河</h1><div class="book-chapter-list"><h3>正文</h3><ul>' + titles.map((title, i) => `<li><a href="/book/${90 - i}.html">${title}</a></li>`).join('') + '</ul></div>'
    const result = parseOnlinePage(html, 'https://example.com/book/')
    expect(result.chapters.map(chapter => chapter.title)).toEqual(titles)
    expect(result.content).toBe('')
  })
  it('separates latest previews from the main directory even inside the same definition list', () => {
    const row = (number: number, title: string) => `<dd><a href="/book/${number}.html">${title}</a></dd>`
    const html = '<h1>山河</h1><div class="listmain"><dl><dt>最新章节</dt>' + row(3, '回家') + row(2, '行路') + '<dt>正文卷</dt>' + row(1, '初见') + row(2, '行路') + row(3, '回家') + '</dl></div>'
    expect(parseOnlinePage(html, 'https://example.com/book/').chapters.map(chapter => chapter.title)).toEqual(['初见', '行路', '回家'])
  })
  it('accepts a structured directory whose chapters are hosted on another domain', async () => {
    const row = (number: number, title: string) => `<dd><a href="//chapters.example.net/book/42/${number}.html">${title}</a></dd>`
    const html = '<h1>山河</h1><div id="intro">' + body + '</div><div id="list"><dl><dt>最新章节</dt>' + row(3, '第3章 归来') + row(2, '第2章 行路') + '<dt>正文卷</dt>' + row(0, '第0章 感言') + row(1, '第1章 初见') + row(2, '第2章 行路') + row(3, '第3章 归来') + '</dl></div><aside><a href="https://ads.example.org/1">第999章 推荐</a></aside>'
    const result = await discoverCatalog('https://catalog.example.com/book/42/', async url => ({ url, html }))
    expect(result.catalogUrl).toBe('https://catalog.example.com/book/42/')
    expect(result.chapters.map(chapter => chapter.title)).toEqual(['第0章 感言', '第1章 初见', '第2章 行路', '第3章 归来'])
    expect(result.chapters[0].url).toBe('https://chapters.example.net/book/42/0.html')
    expect(result.warnings).toEqual([])
    expect(parseOnlinePage(html, result.catalogUrl).content).toBe('')
  })
  it('uses structure for cross-domain chapter names and excludes other external URL families', () => {
    const titles = ['作者的话', '学院篇（01）初见', '没有编号的相逢', '终点之后']
    const rows = titles.map((title, i) => `<li><a href="https://text.example.net/read/42/${i}">${title}</a></li>`).join('')
    const html = '<h1>山河</h1><div class="catalog"><h3>正文</h3><ul>' + rows + '<li><a href="https://ads.example.org/read">第999章 广告</a></li></ul></div>'
    const result = parseOnlinePage(html, 'https://example.com/book/42/')
    expect(result.chapters.map(chapter => chapter.title)).toEqual(titles)
  })
  it('does not treat unstructured external chapter-like links as a directory', () => {
    const rows = [1, 2, 3].map(i => `<a href="https://external.example.net/books/${i}">第${i}章 推荐</a>`).join('')
    expect(parseOnlinePage('<h1>山河</h1>' + rows + '<ul><li>' + rows + '</li></ul>', 'https://example.com/book/42/').chapters).toEqual([])
  })
  it('collects multiple volume lists in page order without including a latest preview', () => {
    const list = (titles: string[], offset: number) => '<ul>' + titles.map((title, i) => `<li><a href="/book/${i + offset}">${title}</a></li>`).join('') + '</ul>'
    const html = '<h1>山河</h1><div class="catalog"><h3>最新章节</h3>' + list(['尾声', '归来', '远方'], 7) + '<h3>第一卷</h3>' + list(['开篇', '相逢', '离别'], 1) + '<h3>第二卷</h3>' + list(['远方', '归来', '尾声'], 4) + '</div>'
    expect(parseOnlinePage(html, 'https://example.com/book/').chapters.map(chapter => chapter.title)).toEqual(['开篇', '相逢', '离别', '远方', '归来', '尾声'])
  })
  it('ignores a hidden mirrored directory and keeps unnumbered entries', () => {
    const rows = ['作者的话', '初见', '行路'].map((title, i) => `<li><a href="/book/${i + 1}">${title}</a></li>`)
    const html = '<h1>山河</h1><div class="catalog-body"><ul style="display:none">' + [...rows].reverse().join('') + '</ul><ul>' + rows.join('') + '</ul></div>'
    expect(parseOnlinePage(html, 'https://example.com/book/').chapters.map(chapter => chapter.title)).toEqual(['作者的话', '初见', '行路'])
  })
  it('does not infer a chapter list from site navigation and other-book recommendations', () => {
    const links = ['山河', '远方', '归来'].map((title, i) => `<li><a href="/books/${i}/">${title}</a></li>`).join('')
    const html = '<h1>山河</h1><nav><ul>' + links + '</ul></nav><div class="recommend"><ul>' + links + '</ul></div><ul>' + links + '</ul>'
    expect(parseOnlinePage(html, 'https://example.com/book/').chapters).toEqual([])
  })
  it('follows a preview chapter backlink to the full directory and uses actual book metadata', async () => {
    const preview = '<h1 class="keyword">搜索关键词</h1><h2 class="book-info_title">山河</h2><p class="book-info_author">某作者</p><div class="catalogue_desc">共 6 章</div><div class="chapter-list"><ul>' + ['感言', '初见', '行路'].map((title, i) => `<li><a href="/read/${i + 1}">${title}</a></li>`).join('') + '</ul></div><div id="article">' + body + '</div>'
    const pages: Record<string, string> = { 'https://example.com/preview': preview, 'https://example.com/read/1': chapter('感言') + '<a href="/catalog">目录</a>', 'https://example.com/catalog': '<h1>山河</h1><div class="author">某作者</div>' + directory([1, 2, 3, 4, 5, 6]) }
    const fetch = vi.fn(async (url: string) => ({ url, html: pages[url] }))
    const result = await discoverCatalog('https://example.com/preview', fetch)
    expect(result).toMatchObject({ title: '山河', author: '某作者', catalogUrl: 'https://example.com/catalog', complete: true })
    expect(result.chapters).toHaveLength(6)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://example.com/preview', 'https://example.com/read/1', 'https://example.com/catalog'])
  })
  it('does not mark a short promotional preview as a complete book without a directory backlink', async () => {
    const preview = directory([1, 2, 3]) + '<div class="catalogue_desc">共 600 章</div>'
    await expect(discoverCatalog('https://example.com/book', async url => ({ url, html: url.endsWith('/book') ? preview : chapter('第1章') }))).rejects.toThrow('只展示部分章节')
  })
  it('rejects a site homepage instead of importing its latest-book feed', async () => {
    const html = '<h1>小说网站</h1><div class="list">' + directory([1, 2, 3]) + '</div>'
    await expect(discoverCatalog('https://example.com/', async url => ({ url, html }))).rejects.toThrow('网站首页')
  })
  it('keeps one-entry volumes and arbitrary chapter names under the same directory', () => {
    const volume = (names: string[], start: number) => '<div><h3>正文卷</h3><div class="chapter">' + names.map((name, i) => `<div><a href="/read/${start + i}">${name}</a></div>`).join('') + '</div></div>'
    const html = '<h1>山河</h1><div class="page-directory-content">' + volume(['第1章 初见', '第2章 行路', '第3章 归来'], 1) + volume(['作者的话'], 4) + volume(['没有编号的相逢', '终点之后'], 5) + '</div>'
    expect(parseOnlinePage(html, 'https://example.com/book').chapters.map(c => c.title)).toEqual(['第1章 初见', '第2章 行路', '第3章 归来', '作者的话', '没有编号的相逢', '终点之后'])
  })
  it('does not prepend an enclosing directory header or its latest-chapter shortcut', () => {
    const html = '<h1>山河</h1><div id="list"><p><a href="/3.html">更新至 第3章 归来</a></p><div class="rec-read"><h3>推荐阅读</h3><a href="/other">其他书籍</a></div>' + directory([1, 2, 3]).replace('<div id="list">', '<dl>').replace('</div>', '</dl>') + '</div>'
    expect(parseOnlinePage(html, 'https://example.com/book').chapters.map(c => c.title)).toEqual(['第1章 远行', '第2章 远行', '第3章 远行'])
  })
  it('follows adjacent numeric directory pages without treating the last-page arrow as next', async () => {
    const fetch = vi.fn(async (url: string) => {
      const n = Number(new URL(url).pathname.match(/index_(\d+)/u)?.[1] || 1)
      return { url, html: directory([3 * n - 2, 3 * n - 1, 3 * n]) + '<h3>章节列表，共9章</h3><ul class="pagination">' + [1, 2, 3].map(i => `<li class="${i === n ? 'active' : ''}"><a href="/book/index_${i}.html">${i}</a></li>`).join('') + '<li><a href="/book/index_3.html" aria-label="Next">»</a></li></ul>' }
    })
    const catalog = await discoverCatalog('https://example.com/book/index_1.html', fetch)
    expect(catalog.chapters).toHaveLength(9)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([1, 2, 3].map(n => `https://example.com/book/index_${n}.html`))
  })
  it('uses an explicit complete-directory link instead of keeping only the largest visible volume', async () => {
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/catalog') ? directory([1, 2, 3, 4, 5, 6]) : directory([4, 5, 6]) + '<a href="/catalog">查看完整目录</a>' }))
    expect((await discoverCatalog('https://example.com/book', fetch)).chapters).toHaveLength(6)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('finds a cross-subdomain directory through the explicit reading entry on a book detail page', async () => {
    const pages: Record<string, string> = {
      'https://book.example.com/detail/42': '<h1>山河</h1><a href="https://read.example.com/42/1">立即阅读</a>',
      'https://read.example.com/42/1': chapter('第1章 山河') + '<a href="https://www.example.com/catalog/42">目录</a>',
      'https://www.example.com/catalog/42': directory([1, 2, 3])
    }
    const fetch = vi.fn(async (url: string) => ({ url, html: pages[url] }))
    expect((await discoverCatalog('https://book.example.com/detail/42', fetch)).chapters).toHaveLength(3)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('prefers the actual chapter body over recommended chapter links elsewhere on the page', () => {
    const html = '<h1 class="headline">没有编号的初见</h1><div class="content"><p>' + body + '</p><p>这章没有结束，请点击下一页继续阅读！</p><p>喜欢山河请大家收藏：(example.com)山河更新速度全网最快。</p></div><ul>' + [1, 2, 3].map(n => `<li><a href="/other/${n}">第${n}章 推荐</a></li>`).join('') + '</ul><a href="/1_2">下一页</a>'
    const result = parseOnlinePage(html, 'https://example.com/1')
    expect(result.content).toBe(body)
    expect(result.chapters).toEqual([])
    expect(result.nextPageUrl).toBe('https://example.com/1_2')
  })
  it('stops when the last chapter page labels its directory as the next page', async () => {
    const fetch = vi.fn(async (url: string) => ({ url, html: chapter('第3章 山河', body, '/book') + '<a href="/book">目录</a>' }))
    expect(await extractChapter('https://example.com/3', fetch)).toBe(body)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('recognizes mislabeled chapter pagination and refuses an unfinished numbered page', async () => {
    const fetch = vi.fn(async (url: string) => {
      const n = Number(url.match(/_(\d)$/u)?.[1] || 1)
      return { url, html: chapter('第1章 山河', `第(${n}/3)页<br>${body}${n}`) + (n < 3 ? `<a href="/1_${n + 1}">下一章</a>` : '') }
    })
    expect(await extractChapter('https://example.com/1', fetch)).toBe([1, 2, 3].map(n => body + n).join('\n\n'))
    expect(fetch).toHaveBeenCalledTimes(3)
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第1章', '第(1/3)页<br>' + body) }))).rejects.toThrow('标注还有分页')
  })
  it('strips short reporting widgets and source-address footers without deleting the story', () => {
    const html = chapter('第1章', body + '<p><a href="javascript:posterror()">章节错误，点此报送</a>，报送后维护人员会校正。</p><br>(https://example.com/1)<br>1秒记住小说网：www.example.com。手机版阅读网址：m.example.com')
    expect(parseOnlinePage(html, 'https://example.com/1').content).toBe(body)
  })
  it('does not cache private-font gibberish or a members-only preview as full text', async () => {
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第1章', '\ue123'.repeat(100) + body) }))).rejects.toThrow('特殊字体')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第1章', body) + '<div>会员登录后，可在网页畅读全文</div>' }))).rejects.toThrow('试读片段')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第1章', body) + '<div>这是VIP章节，需要订阅后才能阅读</div>' }))).rejects.toThrow('试读片段')
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: chapter('第1章', body + '正在手打中，请稍等片刻') }))).rejects.toThrow('尚未更新完成')
    expect(parseOnlinePage(chapter('第1章', body + '<span class="review"><span class="review-count">999</span></span>'), 'https://example.com/1').content).toBe(body)
  })
  it('uses the reader chapter title instead of headings from hidden tool dialogs', () => {
    const html = '<h1>听书阅读</h1><div class="reader-content"><div class="reader-box"><div class="title_txtbox">没有编号的初见</div><div class="content">' + body + '</div></div></div>'
    expect(parseOnlinePage(html, 'https://example.com/1')).toMatchObject({ title: '没有编号的初见', content: body })
    expect(parseOnlinePage('<h1>后记</h1><p>讨论热烈：999条段评</p><main class="content">' + body + '</main><button>添加书签</button>', 'https://example.com/2').content).toBe(body)
    expect(() => parseOnlinePage(html + '<div class="reader-content"><div class="Jfandaoban">请在App阅读全文</div></div>', 'https://example.com/1')).toThrow('试读片段')
  })
  it('checks advertised chapter length after merging all pages rather than caching a short preview', async () => {
    await expect(extractChapter('https://example.com/1', async url => ({ url, html: '<span>本章字数：9631</span>' + chapter('第1章', body) }))).rejects.toThrow('只提供部分正文')
    const fetch = async (url: string) => ({ url, html: '<span>本章字数：500</span>' + (url.endsWith('/1') ? chapter('第1章', body, '/1_2') : chapter('第1章', body + '第二页')) })
    expect(await extractChapter('https://example.com/1', fetch)).toBe(body + '\n\n' + body + '第二页')
  })
  it('recognizes a directory heading outside a wrapper and reports rows without usable links', async () => {
    const html = '<h1>山河</h1><h2>章节目录</h2><div><ul>' + ['初见', '行路', '归来'].map((t, i) => `<li><a href="${i + 1}.html">${t}</a></li>`).join('') + '<li>故人</li><li>未完</li></ul></div><p>' + body + '</p>'
    const book = await discoverCatalog('https://example.com/book/index.html', async url => ({ url, html }))
    expect(book.chapters.map(c => c.title)).toEqual(['初见', '行路', '归来'])
    expect(book.warnings).toEqual(['目录中有 2 项未提供可访问链接，已跳过'])
  })
  it('excludes larger recommendation lists and follows a decorated full-directory entry', async () => {
    const preview = '<h1>山河</h1><div class="title">山河</div><ul>' + [4, 5, 6].map(n => `<li><a href="/book/${n}.html">第${n}章 远行</a></li>`).join('') + '<li><a href="/book/">【展开+】查看全部章节列表......</a></li></ul><div class="title">《山河》推荐</div><ul>' + [1, 2, 3, 4, 5].map(n => `<li><a href="/other/${n}/1">第${n}章 推荐书</a></li>`).join('') + '</ul>'
    const fetch = vi.fn(async (url: string) => ({ url, html: url.endsWith('/detail') ? preview : directory([1, 2, 3, 4, 5, 6]) }))
    const book = await discoverCatalog('https://example.com/detail', fetch)
    expect(book.chapters.map(c => c.title)).toEqual([1, 2, 3, 4, 5, 6].map(n => `第${n}章 远行`))
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://example.com/detail', 'https://example.com/book/'])
  })
  it('keeps all sibling volumes including unnumbered author notes in a volume list', () => {
    const volume = (names: string[], start: number) => '<div><div class="volume">分卷阅读</div><ul class="chapter-list">' + names.map((t, i) => `<li><a href="/read/${start + i}">${t}</a></li>`).join('') + '</ul></div>'
    const html = '<h1>山河</h1><div class="volume-list">' + volume(['作者的话', '读者群', '通知'], 1) + volume(['第一章 春', '第二章 夏', '第三章 秋'], 4) + volume(['第一章 归', '第二章 家', '第三章 终', '第四章 后'], 7) + '</div>'
    expect(parseOnlinePage(html, 'https://example.com/catalog').chapters.map(c => c.title)).toEqual(['作者的话', '读者群', '通知', '第一章 春', '第二章 夏', '第三章 秋', '第一章 归', '第二章 家', '第三章 终', '第四章 后'])
  })
  it('reads prose directly under the document body instead of a publishing boilerplate section', () => {
    const html = '<section class="pg-boilerplate"><h2>Publishing information</h2><div>' + 'License text '.repeat(100) + '</div></section><h1>山河</h1><p>' + body + '</p><h5>' + body + '</h5><h4>' + body + '</h4><section class="pg-boilerplate">' + 'License text '.repeat(500) + '</section>'
    expect(parseOnlinePage(html, 'https://example.com/book.html').content).toBe([body, body, body].join('\n\n'))
  })
  it('finds directory navigation with hidden duplicate text or spaced labels', async () => {
    const links = ['<a href="/book">回目录</a>', '<nav class="chapter-nav"><a href="/book"><span>回到书籍目录</span><span aria-hidden="true">目录</span></a></nav>', '<div class="pager"><a href="/book">书 页</a></div>', '<div class="path"><a href="/book">山河最新章节</a>(目录)</div>']
    for (const link of links) {
      const fetch = async (url: string) => ({ url, html: url.endsWith('/book') ? directory([1, 2, 3]) : chapter('第2章') + link })
      expect((await discoverCatalog('https://example.com/2', fetch)).chapters).toHaveLength(3)
    }
  })
  it('keeps the actual article heading and removes breadcrumbs and directory controls from prose', () => {
    const html = '<h1>山河 · 无编号的相逢</h1><article class="chapter-content"><p><a href="/">首页</a> &gt; <a href="/book">山河</a> &gt; 正文</p><h2>无编号的相逢</h2><p>' + body + '</p><p>某某书屋（www.example.com）</p><p>返回列表 <a href="/book">回目录</a> <a href="/3">下一章</a></p><p>· <b>推荐：</b><a href="/other">其他书</a></p></article>'
    expect(parseOnlinePage(html, 'https://example.com/2')).toMatchObject({ title: '山河 · 无编号的相逢', content: '无编号的相逢\n\n' + body })
    const article = html.replace('<article class="chapter-content"><p><a href="/">首页</a> &gt; <a href="/book">山河</a> &gt; 正文</p>', '<article class="chapter-content">')
    expect(parseOnlinePage(article, 'https://example.com/2')).toMatchObject({ title: '无编号的相逢', content: body })
  })
})
