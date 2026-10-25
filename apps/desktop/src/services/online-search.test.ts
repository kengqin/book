// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { filterNovelHits, loadSearchBatch, novelSearchQuery, parseSearchPage, searchBrowserUrl, searchEngineOptions, searchPublicBooks } from './online-search'

const hit = (number: number) => ({ title: `山河 ${number}`, url: `https://example.com/${number}`, description: '' })

describe('ten-result search batches', () => {
  it('shows ten results and retains extra engine results for the next batch', async () => {
    const batch = await loadSearchBatch(async () => ({ hits: Array.from({ length: 13 }, (_, index) => hit(index)), next: 'page2' }), { initial: true })
    expect(batch.hits).toHaveLength(10)
    expect(batch.pending.map(hit => hit.url)).toEqual([hit(10).url, hit(11).url, hit(12).url])
    expect(batch.next).toBe('page2')
  })
  it('preserves buffered and engine order including repeated URLs, with ten per page', async () => {
    const batch = await loadSearchBatch(async () => ({ hits: Array.from({ length: 14 }, (_, index) => hit(index + 11)), next: 'page3' }), { pending: [hit(10), hit(11), hit(12)], cursor: 'page2' })
    expect(batch.hits.map(hit => hit.url)).toEqual([10, 11, 12, 11, 12, 13, 14, 15, 16, 17].map(number => hit(number).url))
    expect(batch.pending).toHaveLength(7)
    expect(batch.next).toBe('page3')
  })
  it('continues through short engine pages while retaining all results', async () => {
    const batch = await loadSearchBatch(async cursor => cursor === 'page2' ? { hits: [hit(1), hit(2)], next: 'page3' } : { hits: [hit(3)] }, { cursor: 'page2' })
    expect(batch.hits).toEqual([hit(1), hit(2), hit(3)])
    expect(batch.next).toBeUndefined()
  })
  it('does not publish a new partial page when confirmation is cancelled', async () => {
    await expect(loadSearchBatch(async () => { throw new Error('网页搜索已取消') }, { pending: [hit(1)], cursor: 'page2' })).rejects.toThrow('已取消')
  })
  it('keeps already loaded matches and a retry cursor if a later page requires confirmation', async () => {
    const batch = await loadSearchBatch(async () => { throw new Error('需要确认') }, { pending: [hit(1)], cursor: 'page2' })
    expect(batch.hits).toEqual([hit(1)])
    expect(batch.next).toBe('page2')
    expect(batch.warning).toBe('需要确认')
    await expect(loadSearchBatch(async () => { throw new Error('需要确认') }, { initial: true })).rejects.toThrow('确认')
  })
})

describe('search engine adapters', () => {
  it('extracts Bing novel results and its actual next-page cursor', () => {
    const page = parseSearchPage('<li class="b_algo"><h2><a href="https://example.com/book">小说章节目录</a></h2><div class="b_caption"><p>简介</p></div></li><a class="sb_pagN" href="/search?q=novel&first=11">下一页</a>', 'https://www.bing.com/search?q=novel', 'bing')
    expect(page.hits[0]).toEqual({ title: '小说章节目录', url: 'https://example.com/book', description: '简介' })
    expect(page.next).toContain('first=11')
  })
  it('keeps Baidu destination URLs rather than losing them behind tracking links', () => {
    const page = parseSearchPage('<div class="result" mu="https://example.com/book"><h3><a href="https://www.baidu.com/link?url=token">书名 小说</a></h3><div class="c-abstract">简介</div></div><a class="n" href="/s?wd=novel&pn=10">下一页</a>', 'https://www.baidu.com/s?wd=novel', 'baidu')
    expect(page.hits[0].url).toBe('https://example.com/book')
    expect(page.next).toContain('pn=10')
  })
  it('decodes DuckDuckGo result redirects', () => {
    const page = parseSearchPage('<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fbook">书名</a><a class="result__snippet">简介</a></div>', 'https://html.duckduckgo.com/html/?q=novel', 'duckduckgo', false)
    expect(page.hits[0].url).toBe('https://example.com/book')
  })
  it('reports verification instead of fabricating no-results or bypassing it', () => {
    expect(() => parseSearchPage('<title>百度安全验证</title>', 'https://www.baidu.com/s', 'baidu')).toThrow('验证')
    expect(() => parseSearchPage('<form action="/anomaly.js" id="challenge-form"></form>', 'https://html.duckduckgo.com/html', 'duckduckgo')).toThrow('验证')
    expect(() => parseSearchPage('<title>搜狗搜索</title><p>此验证码用于确认这些请求是您的正常行为</p>', 'https://www.sogou.com/web', 'sogou')).toThrow('验证')
    expect(() => parseSearchPage('<form action="/sorry/index"><p>Our systems have detected unusual traffic from your computer</p></form>', 'https://www.google.com/sorry/index', 'google')).toThrow('验证')
    expect(() => parseSearchPage('<title>Google Search</title><p>Please click here if you are not redirected within a few seconds.</p>', 'https://www.google.com/search', 'google')).toThrow('浏览器')
  })
  it('returns every engine result in its original order when the novel filter is off', () => {
    const results = [{title:'小说章节',url:'https://example.com/book',description:''},{title:'小说章节',url:'https://example.com/book',description:''},{title:'百科',url:'https://baike.baidu.com/item/1',description:''},{title:'动画第1集',url:'https://v.qq.com/1',description:''}]
    expect(filterNovelHits(results, false)).toEqual(results)
    expect(searchBrowserUrl('baidu', '山河')).toContain('baidu.com/s?wd=')
  })
  it('filters by novel content while keeping engine order and repeated novel URLs', () => {
    const related = { title: '神道帝尊 - 天蚕土豆作品 - 章节目录', url: 'https://example.com/book', description: '' }
    const author = { title: '天蚕土豆的全部小说', url: 'https://example.com/author', description: '' }
    const dictionary = { title: '天 tiān - 汉典', url: 'https://www.zdic.net/hans/天', description: '天的意思、拼音和笔顺' }
    expect(filterNovelHits([dictionary, author, related, related])).toEqual([author, related, related])
    expect(novelSearchQuery(' 天蚕土豆 ')).toBe('天蚕土豆')
  })
  it('keeps novel-related encyclopedia pages but excludes a video adaptation', () => {
    const video = { title: '山河视频', url: 'https://v.qq.com/1', description: '' }
    const novel = { title: '山河小说章节目录', url: 'https://example.com/book', description: '' }
    const encyclopedia = { title: '山河百科', url: 'https://baike.baidu.com/item/1', description: '网络小说作品' }
    expect(filterNovelHits([video, encyclopedia, novel])).toEqual([encyclopedia, novel])
  })
  it('offers Google and removes Yandex', () => {
    expect(searchEngineOptions.map(option => option.value)).toEqual(['bing', 'baidu', 'google', 'sogou', 'so360', 'duckduckgo', 'brave'])
  })
  it('sends the original full keyword and uses an exact-keyword RSS fallback when HTML has no result links', async () => {
    const urls: string[] = []
    const page = await searchPublicBooks('bing', '天蚕土豆', async url => {
      urls.push(url)
      return { url, html: url.includes('format=rss') ? '<rss><channel><item><title>天蚕土豆作品目录</title><link>https://example.com/author</link><description>小说</description></item></channel></rss>' : '<title>搜索</title>' }
    })
    expect(urls.map(url => new URL(url).searchParams.get('q'))).toEqual(['天蚕土豆', '天蚕土豆'])
    expect(page.hits.map(hit => hit.title)).toEqual(['天蚕土豆作品目录'])
  })
  it.each([
    ['sogou', '<div class="vrwrap"><h3><a href="https://example.com/book">斗破苍穹章节目录</a></h3><div class="str_info">天蚕土豆作品</div></div>'],
    ['so360', '<li class="res-list"><h3><a href="https://example.com/book">斗破苍穹章节目录</a></h3><p class="res-desc">天蚕土豆作品</p></li>'],
    ['google', '<div class="g"><a href="/url?q=https%3A%2F%2Fexample.com%2Fbook"><h3>斗破苍穹章节目录</h3></a><div class="VwiC3b">天蚕土豆作品</div></div>']
  ] as const)('extracts %s destinations and related text', (engine, html) => {
    const url = searchBrowserUrl(engine, '斗破苍穹')
    expect(parseSearchPage(html, url, engine).hits).toEqual([{ title: '斗破苍穹章节目录', url: 'https://example.com/book', description: '天蚕土豆作品' }])
  })
  it('removes Bing session tracking while retaining the actual next offset and full query', () => {
    const page = parseSearchPage('<a class="sb_pagN" href="/search?q=神通者&FPIG=old,older&FPIG=new&rdr=1&rdrig=token&first=21&FORM=PORE">下一页</a>', 'https://cn.bing.com/search?q=神通者&first=11', 'bing')
    const next = new URL(page.next!)
    expect([...next.searchParams.entries()]).toEqual([['q', '神通者'], ['first', '21']])
    expect(next.hostname).toBe('cn.bing.com')
  })
  it.each([
    ['baidu', '<a aria-label="下一页" href="/s?wd=山河&pn=10">→</a>', 'https://www.baidu.com/s?wd=山河', 'pn=10'],
    ['sogou', '<a id="sogou_next" href="/web?query=山河&page=2">下一页</a>', 'https://www.sogou.com/web?query=山河', 'page=2'],
    ['so360', '<a id="next" href="/s?q=山河&pn=2">&gt;</a>', 'https://www.so.com/s?q=山河', 'pn=2'],
    ['google', '<a id="pnnext" href="/search?q=山河&start=10"><span>Next</span></a>', 'https://www.google.com.hk/search?q=山河', 'start=10'],
    ['duckduckgo', '<form action="/html/"><input name="q" value="山河"><input name="s" value="30"><input type="submit" value="Next"></form>', 'https://html.duckduckgo.com/html/?q=山河', 's=30']
  ] as const)('keeps the %s next-page cursor', (engine, html, url, expected) => {
    expect(parseSearchPage(html, url, engine).next).toContain(expected)
  })
  it('finds a Baidu numbered next page without a text label and removes tracking parameters', () => {
    const page = parseSearchPage('<div id="page"><a href="/s?wd=公考捡漏&pn=0">1</a><a href="/s?wd=公考捡漏&pn=10&rsv_t=old&oq=公&ie=utf-8">2</a></div>', 'https://www.baidu.com/s?wd=公考捡漏', 'baidu')
    expect([...new URL(page.next!).searchParams.entries()]).toEqual([['wd', '公考捡漏'], ['pn', '10'], ['ie', 'utf-8']])
  })
  it('keeps Baidu pageable when its pager has not been rendered, then ends on an empty page', () => {
    const html = '<div class="result"><h3><a href="https://example.com/book">公考捡漏小说</a></h3></div>'
    const first = parseSearchPage(html, 'https://www.baidu.com/s?wd=公考捡漏&rsv_t=old', 'baidu')
    expect(new URL(first.next!).searchParams.get('pn')).toBe('10')
    const second = parseSearchPage(html, first.next!, 'baidu')
    expect(new URL(second.next!).searchParams.get('pn')).toBe('20')
    expect(parseSearchPage('<p>没有找到相关结果</p>', second.next!, 'baidu').next).toBeUndefined()
  })
  it('stops at the explicit Baidu last page instead of repeatedly requesting its clamped results', () => {
    const html = '<div class="result"><h3><a href="https://example.com/book">神通者小说</a></h3></div><div id="page"><a href="/s?wd=神通者&pn=0">1</a><strong>2</strong></div>'
    expect(parseSearchPage(html, 'https://www.baidu.com/s?wd=神通者&pn=10', 'baidu').next).toBeUndefined()
    expect(parseSearchPage(html, 'https://www.baidu.com/s?wd=神通者&pn=20', 'baidu').next).toBeUndefined()
  })
  it('does not mistake an empty Baidu pager placeholder for an explicit last page', () => {
    const html = '<div class="result-op c-container"><h3><a href="https://example.com/book">斗破苍穹小说</a></h3></div><div id="page"><div class="page-inner_2jZi2"><!--201--></div></div>'
    expect(new URL(parseSearchPage(html, 'https://www.baidu.com/s?wd=斗破苍穹', 'baidu').next!).searchParams.get('pn')).toBe('10')
  })
  it('keeps Sogou pageable when its pager is absent, retaining the query and removing tracking', () => {
    const html = '<div class="vrwrap"><h3><a href="https://example.com/book">山河小说</a></h3></div>'
    const first = parseSearchPage(html, 'https://www.sogou.com/web?query=山河&sourceid=old', 'sogou')
    expect([...new URL(first.next!).searchParams.entries()]).toEqual([['query', '山河'], ['page', '2']])
    expect(new URL(parseSearchPage(html, first.next!, 'sogou').next!).searchParams.get('page')).toBe('3')
    expect(parseSearchPage('<p>没有找到相关结果</p>', first.next!, 'sogou').next).toBeUndefined()
  })
  it('respects an explicit Sogou last page', () => {
    expect(parseSearchPage('<div class="vrwrap"><h3><a href="https://example.com/book">神通者小说</a></h3></div><div id="pagebar"><a href="/web?query=神通者&page=1">1</a><span>2</span></div>', 'https://www.sogou.com/web?query=神通者&page=2', 'sogou').next).toBeUndefined()
  })
  it('keeps traditional Chinese novel results when the novel filter is enabled', () => {
    const hit = { title: '神通者 - 繁體小說', url: 'https://example.com/book', description: '最新章節在線閱讀' }
    expect(filterNovelHits([hit])).toEqual([hit])
  })
  it('decodes Google Hong Kong destination links', () => {
    const page = parseSearchPage('<div class="g"><a href="/url?url=https%3A%2F%2Fexample.com%2Fbook"><h3>山河小说</h3></a></div>', 'https://www.google.com.hk/search?q=山河', 'google')
    expect(page.hits[0].url).toBe('https://example.com/book')
  })
  it('continues a rendered DuckDuckGo result list by its real More Results control', () => {
    const rows = (numbers: number[]) => numbers.map(n => `<a data-testid="result-title-a" href="https://example.com/${n}">山河小说 ${n}</a>`).join('')
    const first = parseSearchPage(rows([1, 2, 3]) + '<button id="more-results">更多结果</button>', 'https://duckduckgo.com/?q=山河', 'duckduckgo')
    expect(first.next).toContain('#reader-offset=3')
    const second = parseSearchPage(rows([1, 2, 3, 4, 5]) + '<button id="more-results">更多结果</button>', first.next!, 'duckduckgo')
    expect(second.hits.map(hit => hit.title)).toEqual(['山河小说 4', '山河小说 5'])
    expect(second.next).toContain('#reader-offset=5')
    expect(parseSearchPage(rows([1, 2, 3, 4, 5]), first.next!, 'duckduckgo').next).toBeUndefined()
  })
})
