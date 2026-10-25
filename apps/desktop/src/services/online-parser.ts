import { isVerificationPage } from './online-verification'

/** Parses inert HTML only. No remote scripts, styles, or markup enter the reader. */
export interface ChapterLink { title: string; url: string }
export interface OnlineCatalog { title: string; author: string; description: string; catalogUrl: string; chapters: ChapterLink[]; warnings: string[]; complete?: boolean }
export interface DiscoveryProgress { pages: number; chapters: number; stage: 'fetching' | 'catalog' }
export interface ParsedPage {
  title: string; bookTitle: string; author: string; description: string
  chapters: ChapterLink[]; content: string; catalogUrl?: string; readingUrl?: string; firstCatalogUrl?: string; nextCatalogUrl?: string; nextPageUrl?: string
  declaredChapterCount?: number
  declaredWordCount?: number
  unlinkedChapterCount?: number
  pageNumber?: number; pageCount?: number
}
const chapterPattern = /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回集]|序章|楔子|引子|番外|尾声|后记|终章|Chapter\s+\d+)/iu
const clean = (text: string | null | undefined) => (text || '').replace(/\s+/gu, ' ').trim()
const directoryLabel = (text: string) => /^(?:(?:回到|返回|回|查看|全部|完整|章节|小说|本书|书籍))*(?:章节)?目录(?:页)?$|^(?:查看|展开)?(?:全部|完整|所有)?章节列表$|^全部章节$/u.test(text.replace(/\s+/gu, '').replace(/^[【\[].{0,12}?[】\]]/u, '').replace(/[.…·>›»→]+$/u, ''))
const directoryContainer = '[class*="chapter"],[id*="chapter"],[class*="catalog"],[id*="catalog"],[class*="directory"],[class*="volume-list"],[class*="volume_list"],#list'

export function httpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return
    url.hash = ''
    return url.href
  } catch { return }
}

function textLines(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('a[href*="posterror"],a[onclick*="posterror"],a[href*="chaptererror"]').forEach(anchor => {
    const paragraph = anchor.closest('p')
    if (paragraph && (paragraph.textContent?.length || 0) < 300) paragraph.remove()
  })
  copy.querySelectorAll('p').forEach(paragraph => {
    const links = Array.from(paragraph.querySelectorAll('a'))
    const text = clean(paragraph.textContent)
    if (text.length < 160 && links.length && (links.some(link => directoryLabel(clean(link.textContent)))
      || /^(?:首页\s*>|[·•]?\s*推荐[：:])/u.test(text))) paragraph.remove()
  })
  copy.querySelectorAll('script,style,noscript,iframe,form,button,nav,header,footer,aside,svg,canvas,a,[hidden],[aria-hidden="true"],.ads,.ad,.advertisement,.recommend,.navigation,.chapter-nav,.review,.review-count,.pg-boilerplate').forEach(node => node.remove())
  copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'))
  copy.querySelectorAll('p,div,li,section,h1,h2,h3,h4,h5,h6').forEach(node => node.append('\n'))
  return (copy.textContent || '').split(/\n+/u).map(line => line.replace(/[\t\r \u00a0\u3000]+/gu, ' ').trim())
    .filter(line => line && !/^(?:上一[章页]|下一[章页]|返回目录|加入书签|手机用户请访问|请记住本站域名|本章未完.*下一页|章节错误.*举报|[一1]秒记住|手机版阅读网址|这章没有结束.*下一页|喜欢.+请大家收藏)/u.test(line)
      && !/^[（(]?https?:\/\/\S+[)）]?$/u.test(line)
      && !/^\S{1,20}(?:书屋|小说网|文学网|书阁)[（(](?:https?:\/\/)?www\.[a-z\d.-]+[)）]$/iu.test(line)
      && !/^《.+》无错的章节将持续在.{1,30}更新[,，].*收藏和推荐/u.test(line)
      && !/^第\s*[（(]?\s*\d+\s*[/／]\s*\d+\s*[)）]?\s*页$/u.test(line)).join('\n\n')
}

export function normalizedChapterTitle(title: string) {
  return title.replace(/(?:[（(\[【]\s*第?\s*\d+\s*[/／]\s*\d+\s*页?\s*[)）\]】]|第\s*\d+\s*页|[_|｜].*)/gu, '').replace(/\s+/gu, '').trim()
}

export function parseOnlinePage(html: string, url: string, options: { allowShortContinuation?: boolean } = {}): ParsedPage {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const meta = (...names: string[]) => {
    for (const name of names) {
      const el = doc.querySelector(`meta[property="${name}"],meta[name="${name}"]`)
      const value = clean(el?.getAttribute('content'))
      if (value) return value
    }
    return ''
  }
  const chapterHeading = doc.querySelector('h1.headline,.chapter-title,.read-title,.muye-reader-title,.content > h3.title,.reader-content .title_txtbox,.chapter-wrapper h1,.chapter-content > h2:first-child')
  const heading = chapterHeading || Array.from(doc.querySelectorAll('h1')).find(el => !el.closest('.logo,header,.header,nav,[class*="reader-nav"]') && !el.matches('.keyword')) || doc.querySelector('.book-info_title,.book-title,[itemprop="name"]')
  const title = clean(heading?.textContent) || meta('og:novel:chapter_name', 'og:title') || clean(doc.title)
  if (isVerificationPage(doc)) {
    throw new Error('网站要求验证，暂时无法自动提取；请打开原网页或换一个来源')
  }
  if (new URL(url).pathname === '/' && !meta('og:novel:book_name', 'novel:book_name')) throw new Error('这是网站首页，请粘贴小说详情页、目录页或章节链接')
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]')).map(a => {
    const label = a.cloneNode(true) as Element
    label.querySelectorAll('[hidden],[aria-hidden="true"],script,style,svg').forEach(node => node.remove())
    return { element: a, title: clean(label.textContent) || clean(a.getAttribute('aria-label')) || clean(a.getAttribute('title')), url: httpUrl(a.getAttribute('href') || '', url) }
  }).filter(a => a.url && a.url !== httpUrl(url))
  const sameOrigin = (link: string) => new URL(link).origin === new URL(url).origin
  const sameSite = (link: string) => new URL(link).hostname.replace(/^(?:www|m|wap|read|book)\./u, '') === new URL(url).hostname.replace(/^(?:www|m|wap|read|book)\./u, '')
  const excluded = 'nav,header,footer,aside,.recommend,.rec-read,.related,.latest,[class*="latest-"],[class*="latest_"],[class*="recommend"],[class*="related"],[hidden],[aria-hidden="true"]'
  const candidatesForDirectory = anchors.filter(a => {
    if (!a.title || a.element.closest(excluded) || directoryLabel(a.title) || /^(?:上一[页章]|下一[页章]|返回书架|首页|尾页|\d+|开始阅读|继续阅读)$/u.test(a.title)) return false
    for (let element: Element | null = a.element; element; element = element.parentElement) if (/display\s*:\s*none\b/iu.test(element.getAttribute('style') || '')) return false
    return true
  })
  // Infer repeated chapter rows from their directory structure and URL family.
  // Chapter names remain opaque text; they do not need to follow a title format.
  const groups = new Map<Element, typeof candidatesForDirectory>()
  for (const anchor of candidatesForDirectory) {
    const container = anchor.element.closest('dl,ul,ol,table') || anchor.element.parentElement?.closest('[id*="list"],[class*="list"],[class*="catalog"],[class*="directory"],.chapter')
    if (!container) continue
    const group = groups.get(container) || []; group.push(anchor); groups.set(container, group)
  }
  const isSectionHeading = (element: Element) => element.matches('dt,h2,h3,h4') || /(?:^|[-_ ])title(?:$|[-_ ])/u.test(element.className) && clean(element.textContent).length < 100
  const sectionLabel = (container: Element) => {
    // A heading can precede a wrapper around the list, rather than the list itself.
    for (let element: Element | null = container, depth = 0; element && depth < 3 && element !== doc.body; element = element.parentElement, depth++) {
      if (element.previousElementSibling) return isSectionHeading(element.previousElementSibling) ? clean(element.previousElementSibling.textContent) : ''
    }
    return ''
  }
  const basePath = new URL(url).pathname.replace(/\/$/u, '') + '/'
  const linkFamily = (link: string) => {
    const target = new URL(link)
    return target.origin + target.pathname.replace(/[^/]+\/?$/u, '')
  }
  const directories = [...groups.entries()].flatMap(([container, items]) => {
    const sections = new Map<Element, string>()
    let label = sectionLabel(container)
    if (/推荐|猜你喜欢|相关作品/u.test(label)) return []
    for (const row of container.children) {
      if (isSectionHeading(row)) label = clean(row.textContent)
      sections.set(row, label)
    }
    const neighboringHeadings = Array.from(container.parentElement?.children || []).filter(isSectionHeading).map(element => clean(element.textContent))
    const hasMainSection = [...sections.values(), ...neighboringHeadings].some(text => /正文|目录|章节列表|全文|全书|卷/u.test(text) && !/最新|最近|推荐/u.test(text))
    const selected = items.filter(anchor => {
      let row = anchor.element as Element
      while (row.parentElement && row.parentElement !== container) row = row.parentElement
      return !hasMainSection || !/最新|最近|推荐/u.test(sections.get(row) || '')
    })
    if (!selected.length) return []
    const chapterContext = container.closest(directoryContainer)
    const childLinks = selected.filter(a => new URL(a.url!).pathname.startsWith(basePath)).length
    const families = new Map<string, number>()
    for (const anchor of selected) {
      const family = linkFamily(anchor.url!)
      families.set(family, (families.get(family) || 0) + 1)
    }
    const [family, count] = [...families.entries()].sort((a, b) => b[1] - a[1])[0]
    const coherent = count >= selected.length * 0.8
    const directoryContext = chapterContext || hasMainSection || basePath !== '/' && childLinks >= selected.length * 0.8
    // Catalogs can host their chapter files on a different domain. Accept that
    // repeated URL family only inside an established directory, never as loose links.
    const links = selected.filter(a => sameOrigin(a.url!) || coherent && directoryContext && linkFamily(a.url!) === family)
    const formatted = links.filter(a => chapterPattern.test(a.title)).length
    return formatted >= 2 || coherent && directoryContext ? [{ container, links }] : []
  })
  const dominant = directories.filter(group => group.links.length >= 3).sort((a, b) => b.links.length - a.links.length)[0]
  const directoryRoot = (container: Element) => {
    let root = container
    for (let element: Element | null = container; element; element = element.parentElement) {
      if (element.matches('div,section,main') && element.matches(directoryContainer)) root = element
    }
    return root
  }
  const selectedGroups = dominant ? directories.filter(group => directoryRoot(group.container) === directoryRoot(dominant.container)
    && !directories.some(other => other !== group && other.links.length >= 3 && group.container.contains(other.container))) : []
  const selected = dominant ? selectedGroups.flatMap(group => group.links) : candidatesForDirectory.filter(a => sameOrigin(a.url!) && chapterPattern.test(a.title))
  const unlinkedChapterCount = selectedGroups.reduce((count, { container }) => count + Array.from(container.querySelectorAll('li,dd')).filter(row =>
    clean(row.textContent) && !isSectionHeading(row) && !row.querySelector('a,button,input,select,li,dd') && !/^(?:上一页|下一页|首页|尾页|\d+)$/u.test(clean(row.textContent))).length, 0)
  const seen = new Set<string>()
  let chapters = selected.filter(a => !seen.has(a.url!) && Boolean(seen.add(a.url!))).map(a => ({ title: a.title, url: a.url! }))
  const firstNumber = (s: string) => Number(s.match(/^第\s*(\d+)/u)?.[1] || 0)
  // Reverse only clearly descending numeric directories, never alphabetically sort chapter URLs.
  const numbered = chapters.map(c => firstNumber(c.title)).filter(Boolean)
  if (numbered.length >= 3 && numbered.every((n, i) => !i || n < numbered[i - 1])) chapters = chapters.reverse()

  const explicit = Array.from(doc.querySelectorAll('#content,#chaptercontent,#chapter-content,#BookText,#txt,#article,main.content,article.content,.read-content,.chapter-content,.chapter_content,.chaptercontent,.muye-reader-content,.novel-content,[itemprop="articleBody"]' + (chapterHeading || chapterPattern.test(title) ? ',.content' : '')))
  const bodyParagraphs = Array.from(doc.body.children).filter(el => el.matches('p,h2,h3,h4,h5,h6') && clean(el.textContent).length >= 60)
  const candidates = explicit.length ? explicit : [...Array.from(doc.querySelectorAll('article,main,section,div')), ...(bodyParagraphs.length >= 3 ? [doc.body] : [])].filter(el => {
    const length = el.textContent?.length || 0
    const linked = Array.from(el.querySelectorAll('a')).reduce((sum, a) => sum + (a.textContent?.length || 0), 0)
    return length >= 80 && linked / length < 0.15 && !el.closest('nav,header,footer,aside,.pg-boilerplate')
  })
  // A confirmed chapter's final page can contain only a few lines. Only an
  // explicit body may be short; extractChapter still checks the chapter title.
  const minimumBodyLength = options.allowShortContinuation && explicit.length ? 1 : 80
  const bodies = candidates.map(el => ({ text: textLines(el), size: el.querySelectorAll('*').length }))
    .filter(v => v.text.replace(/\s/gu, '').length >= minimumBodyLength)
    .sort((a, b) => (b.text.length / (1 + b.size * 0.015)) - (a.text.length / (1 + a.size * 0.015)))
  let content = bodies[0]?.text || ''
  const chapterBody = content && explicit.length && (chapterHeading || chapterPattern.test(title))
  if (!chapterBody && (dominant || !explicit.length && chapters.length >= 3)) content = ''
  if (chapterBody) chapters = []
  if (content && /^(?:请先登录|登录后阅读|订阅后阅读|本章为付费章节)/u.test(content)) throw new Error('该章节需要在原网站登录或订阅')
  const visible = doc.body.cloneNode(true) as Element
  visible.querySelectorAll('script,style,noscript').forEach(el => el.remove())
  if (content && /会员登录后[，,\s]*可在网页畅读全文|订阅后(?:可)?阅读|需要订阅后才能阅读|本章为付费章节/u.test(visible.textContent || '')) throw new Error('该章节需要在原网站登录或订阅，未保存试读片段')
  if (content && doc.querySelector('.reader-content .Jfandaoban')) throw new Error('原网页仅提供试读片段，需要在原网站或其 App 阅读，未保存不完整正文')
  if (/正在手打中[，,\s]*请稍等片刻|内容更新后[，,\s]*请重新刷新页面/u.test(content)) throw new Error('原网页正文尚未更新完成，请稍后重试，未保存不完整正文')
  const privateCharacters = content.match(/[\ue000-\uf8ff]/gu)?.length || 0
  if (privateCharacters >= 8 && privateCharacters / content.length > 0.02) throw new Error('原网页使用特殊字体编码，暂时无法转换为正常正文，请在原网页阅读')
  const lines = content.split('\n\n')
  if (normalizedChapterTitle(lines[0] || '') === normalizedChapterTitle(title)) lines.shift()
  if (normalizedChapterTitle(lines.at(-1) || '') === normalizedChapterTitle(title)) lines.pop()
  content = lines.join('\n\n')
  const directory = anchors.find(a => sameSite(a.url!) && (directoryLabel(a.title) || a.element.rel === 'index'
    || a.title.replace(/\s/gu, '') === '书页' && a.element.closest('.pager,.chapter-nav')
    || a.element.closest('.path,[class*="breadcrumb"]') && /^[（(]\s*目录\s*[)）]/u.test(a.element.nextSibling?.textContent || '')))
  const reading = anchors.find(a => /^(?:立即阅读|免费试读|开始阅读|点击阅读)$/u.test(a.title) && !a.element.closest(excluded))
  const pager = '.pagination,.pages,.pager,.pagelist,.pagebar,.page_bar,.index-container'
  const pageLinks = anchors.filter(a => a.element.closest(pager) && sameOrigin(a.url!))
  const currentPage = Number(clean(doc.querySelector(`${pager.split(',').map(selector => `${selector} [aria-current="page"],${selector} .active,${selector} .current`).join(',')}`)?.textContent).match(/^\d+$/u)?.[0])
  const numericNext = currentPage ? pageLinks.find(a => a.title === String(currentPage + 1)) : undefined
  const next = anchors.find(a => /^(?:下一页|下页|下一頁|next page)[>»›→\s]*$/iu.test(a.title) && sameSite(a.url!)) || numericNext
  const bodyPage = (doc.body.textContent || '').match(/第\s*[（(]?\s*(\d+)\s*[/／]\s*(\d+)\s*[)）]?\s*页/u)
  const pageNumber = bodyPage ? Number(bodyPage[1]) : undefined
  const pageCount = bodyPage ? Number(bodyPage[2]) : undefined
  const words = (visible.textContent || '').match(/本章字数[：:\s]*([\d.]+)\s*(万)?/u)
  const declaredWordCount = words ? Number(words[1]) * (words[2] ? 10000 : 1) : undefined
  const continuedChapter = pageNumber && pageCount && pageNumber < pageCount ? anchors.find(a => /^下一章[>»›→\s]*$/u.test(a.title) && sameSite(a.url!)) : undefined
  const pageSelect = Array.from(doc.querySelectorAll('select')).find(select => {
    const options = Array.from(select.querySelectorAll('option'))
    return options.length > 1 && options.every(option => /\d+\s*[-–—~至]\s*\d+/u.test(option.textContent || ''))
  })
  const firstOption = pageSelect?.querySelector('option')?.getAttribute('value')
  const firstLink = anchors.find(a => /^(?:首页|第一页|首[ 页]|first)$/iu.test(a.title) && a.element.closest('.pagination,.page,.pages,.index-container,[class*="pager"]')) || pageLinks.find(a => a.title === '1')
  const firstCatalogUrl = firstOption ? httpUrl(firstOption, url) : firstLink?.url
  const bookTitle = meta('og:novel:book_name', 'novel:book_name') || (chapterPattern.test(title) ? '' : title.replace(/(?:最新章节|全文阅读|章节目录|无弹窗).*$/u, '').replace(/[_|｜-].*$/u, '').trim())
  const countText = clean(doc.querySelector('.catalogue_desc,.catalog-desc,.catalog-count,[class*="chapter-count"]')?.textContent) || Array.from(doc.querySelectorAll('h2,h3,dt')).map(el => clean(el.textContent)).find(text => /目录|章节列表/u.test(text) && /共\s*[\d,]+\s*[章回]/u.test(text)) || ''
  const declaredChapterCount = Number(countText.match(/共\s*([\d,]+)\s*[章回]/u)?.[1]?.replace(/,/gu, '')) || undefined
  return {
    title, bookTitle, author: meta('og:novel:author', 'author') || clean(doc.querySelector('[itemprop="author"],.book-info_author,.book-author,.author')?.textContent).replace(/^作\s*者\s*[:：]?\s*/u, ''), description: meta('og:description', 'description'),
    chapters: chapters.length >= 2 ? chapters : [], content,
    declaredChapterCount,
    declaredWordCount,
    unlinkedChapterCount: !content && unlinkedChapterCount || undefined,
    catalogUrl: directory?.url,
    readingUrl: reading?.url,
    firstCatalogUrl: !content && firstCatalogUrl && sameOrigin(firstCatalogUrl) ? firstCatalogUrl : undefined,
    nextCatalogUrl: !content && chapters.length >= 2 ? next?.url : undefined,
    nextPageUrl: content ? (next || continuedChapter)?.url : undefined,
    pageNumber, pageCount
  }
}

export type FetchPage = (url: string) => Promise<{ url: string; html: string }>

export async function discoverCatalog(url: string, fetchPage: FetchPage, progress: (value: DiscoveryProgress) => void = () => {}, partial: (catalog: OnlineCatalog) => void | Promise<void> = () => {}): Promise<OnlineCatalog> {
  const initial = httpUrl(url)
  if (!initial) throw new Error('请输入完整的 HTTP/HTTPS 网页链接')
  let current = initial
  const visited = new Set<string>()
  let result: OnlineCatalog | undefined
  let rewound = false
  for (let i = 0; i < 60; i++) {
    if (visited.has(current)) throw new Error('目录分页出现循环，已停止继续解析')
    visited.add(current)
    progress({ pages: i + 1, chapters: result?.chapters.length || 0, stage: 'fetching' })
    const page = await fetchPage(current)
    const parsed = parseOnlinePage(page.html, page.url)
    if (parsed.chapters.length && !parsed.content) {
      if (!result && parsed.catalogUrl && parsed.catalogUrl !== page.url && !visited.has(parsed.catalogUrl)) {
        current = parsed.catalogUrl
        continue
      }
      if (!result && !rewound && !parsed.nextCatalogUrl && parsed.declaredChapterCount && parsed.declaredChapterCount > parsed.chapters.length) {
        // Promotional pages can expose only a short preview. A public chapter's
        // directory backlink identifies the canonical, complete chapter list.
        const chapterPage = await fetchPage(parsed.chapters[0].url)
        const chapter = parseOnlinePage(chapterPage.html, chapterPage.url)
        if (chapter.catalogUrl && chapter.catalogUrl !== page.url && !visited.has(chapter.catalogUrl)) {
          rewound = true
          current = chapter.catalogUrl
          continue
        }
        throw new Error('该页面只展示部分章节，未找到完整目录入口；请打开原网页的完整目录后重试')
      }
      if (!result && !rewound && parsed.firstCatalogUrl && parsed.firstCatalogUrl !== page.url) {
        // Search engines often index a directory's middle page. Start from page
        // one before collecting anything, then follow its forward pagination.
        rewound = true
        visited.clear()
        current = parsed.firstCatalogUrl
        continue
      }
      if (!result) result = { title: parsed.bookTitle || parsed.title, author: parsed.author, description: parsed.description, catalogUrl: page.url, chapters: [], warnings: [] }
      if (parsed.unlinkedChapterCount) result.warnings.push(`目录中有 ${parsed.unlinkedChapterCount} 项未提供可访问链接，已跳过`)
      const known = new Set(result.chapters.map(c => c.url))
      result.chapters.push(...parsed.chapters.filter(c => !known.has(c.url)))
      progress({ pages: i + 1, chapters: result.chapters.length, stage: 'catalog' })
      await partial({ ...result, chapters: [...result.chapters], complete: !parsed.nextCatalogUrl })
      if (!parsed.nextCatalogUrl) return { ...result, complete: true }
      current = parsed.nextCatalogUrl
    } else if (parsed.catalogUrl && !visited.has(parsed.catalogUrl) && !result) {
      current = parsed.catalogUrl
    } else if (parsed.readingUrl && !visited.has(parsed.readingUrl) && !result) {
      current = parsed.readingUrl
    } else if (parsed.content && !result) {
      return { title: parsed.bookTitle || parsed.title || '网页书籍', author: parsed.author, description: parsed.description, catalogUrl: page.url, chapters: [{ title: parsed.title || '正文', url: page.url }], warnings: ['未找到完整目录，已识别为单章。可粘贴目录页链接导入整本书。'], complete: true }
    } else if (parsed.chapters.length && !result) {
      return { title: parsed.bookTitle || parsed.title, author: parsed.author, description: parsed.description, catalogUrl: page.url, chapters: parsed.chapters, warnings: [] }
    } else {
      throw new Error('未能可靠识别目录或正文。网页可能需要登录、动态加载，或使用了暂不支持的结构，请换一个来源')
    }
  }
  throw new Error('目录超过 60 页，已停止继续解析')
}

export async function extractChapter(url: string, fetchPage: FetchPage, chapterUrls?: ReadonlySet<string>): Promise<string> {
  let current = url
  const visited = new Set<string>()
  const parts: string[] = []
  let originalTitle = ''
  let declaredWords = 0
  for (let i = 0; i < 30; i++) {
    if (visited.has(current)) throw new Error('章节分页出现循环，未保存不完整正文')
    visited.add(current)
    const page = await fetchPage(current)
    const parsed = parseOnlinePage(page.html, page.url, { allowShortContinuation: i > 0 })
    if (!parsed.content) throw new Error('未找到足够可靠的正文，可能需要登录、验证或动态加载')
    const title = normalizedChapterTitle(parsed.title)
    if (i && originalTitle && title && title !== originalTitle) throw new Error('下一页的章节标题不同，已停止合并，避免串章')
    if (i && parsed.content.replace(/\s/gu, '').length < 80 && (!originalTitle || title !== originalTitle)) throw new Error('短分页缺少相同的章节标题，未保存不完整正文')
    originalTitle ||= title
    declaredWords = Math.max(declaredWords, parsed.declaredWordCount || 0)
    if (parts.includes(parsed.content)) throw new Error('网站返回了重复的分页正文，未标记完成')
    parts.push(parsed.content)
    // Some mobile sites label the next chapter "下一页". The known directory is authoritative.
    if (parsed.pageNumber && parsed.pageCount && parsed.pageNumber < parsed.pageCount && !parsed.nextPageUrl) throw new Error('网页标注还有分页，但未找到下一页，未保存不完整正文')
    if (!parsed.nextPageUrl || parsed.nextPageUrl === parsed.catalogUrl || chapterUrls?.has(parsed.nextPageUrl) && parsed.nextPageUrl !== url) {
      const content = parts.join('\n\n')
      if (declaredWords >= 500 && content.replace(/\s/gu, '').length < declaredWords * 0.35) throw new Error('原网页只提供部分正文，未保存不完整章节，请在原网页查看')
      return content
    }
    current = parsed.nextPageUrl
  }
  throw new Error('章节分页超过 30 页，已停止读取')
}
