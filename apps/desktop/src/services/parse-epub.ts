import {
  contentTypeFromHref,
  parse,
  type Block,
  type Book,
  type Inline,
  type Table,
  type TOCItem
} from '@abfcode/spine'
import type { ChapterKind, ParsedChapter, ParserResponse, ParseResult } from '@novel-library/reader-core'

type ProgressListener = (message: Extract<ParserResponse, { type: 'progress' }>) => void

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function imageDataUrl(book: Book, source: string, cache: Map<string, string>) {
  const cached = cache.get(source)
  if (cached) return cached
  const bytes = book.openResource(source)
  if (!bytes) return ''
  const dataUrl = `data:${contentTypeFromHref(source)};base64,${bytesToBase64(bytes)}`
  cache.set(source, dataUrl)
  return dataUrl
}

function inlineHtml(inline: Inline, book: Book, imageCache: Map<string, string>) {
  if (inline.kind === 'image') {
    const source = inline.src ? imageDataUrl(book, inline.src, imageCache) : ''
    return source ? `<img src="${source}" alt="${escapeHtml(inline.alt || '')}">` : escapeHtml(inline.alt || '')
  }

  let content = escapeHtml(inline.text || '').replace(/\n/g, '<br>')
  if (inline.code) content = `<code>${content}</code>`
  if (inline.strong) content = `<strong>${content}</strong>`
  if (inline.emph) content = `<em>${content}</em>`
  if (inline.sub) content = `<sub>${content}</sub>`
  if (inline.sup) content = `<sup>${content}</sup>`
  if (inline.kind === 'link' && inline.href?.includes('#')) {
    content = `<a href="#${escapeHtml(inline.href.split('#').at(-1) || '')}">${content}</a>`
  }
  return content
}

// Spine returns structural data only; escape every text field before persisting reader HTML.
function inlinesHtml(inlines: Inline[] | undefined, book: Book, imageCache: Map<string, string>) {
  return (inlines || []).map(inline => inlineHtml(inline, book, imageCache)).join('')
}

function tableHtml(table: Table, book: Book, imageCache: Map<string, string>): string {
  const rows = table.rows.map(row => `<tr>${row.cells.map(cell => {
    const tag = cell.header ? 'th' : 'td'
    const colspan = cell.colspan ? ` colspan="${cell.colspan}"` : ''
    const rowspan = cell.rowspan ? ` rowspan="${cell.rowspan}"` : ''
    const nested = (cell.tables || []).map(item => tableHtml(item, book, imageCache)).join('')
    return `<${tag}${colspan}${rowspan}>${inlinesHtml(cell.inlines, book, imageCache)}${nested}</${tag}>`
  }).join('')}</tr>`).join('')
  return `<table><tbody>${rows}</tbody></table>`
}

function anchorHtml(block: Block) {
  return (block.anchors || []).map(anchor => `<span id="${escapeHtml(anchor)}"></span>`).join('')
}

function singleBlockHtml(block: Block, book: Book, imageCache: Map<string, string>) {
  const anchors = anchorHtml(block)
  const content = inlinesHtml(block.inlines, book, imageCache)
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level || 2))
      return `${anchors}<h${level}>${content}</h${level}>`
    }
    case 'blockquote': return `${anchors}<blockquote>${content}</blockquote>`
    case 'pre': return `${anchors}<pre><code>${content}</code></pre>`
    case 'hr': return `${anchors}<hr>`
    case 'table': return `${anchors}${block.table ? tableHtml(block.table, book, imageCache) : ''}`
    case 'figure': {
      const images = inlinesHtml(block.figure?.images, book, imageCache)
      const caption = inlinesHtml(block.figure?.caption, book, imageCache)
      return `${anchors}<figure>${images}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
    }
    default: return `${anchors}<p>${content}</p>`
  }
}

function blocksHtml(blocks: Block[], book: Book, imageCache: Map<string, string>) {
  const output: string[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.kind !== 'list_item') {
      output.push(singleBlockHtml(block, book, imageCache))
      continue
    }
    const ordered = Boolean(block.ordered)
    const items: string[] = []
    while (index < blocks.length && blocks[index].kind === 'list_item' && Boolean(blocks[index].ordered) === ordered) {
      const item = blocks[index]
      items.push(`${anchorHtml(item)}<li>${inlinesHtml(item.inlines, book, imageCache)}</li>`)
      index += 1
    }
    index -= 1
    const tag = ordered ? 'ol' : 'ul'
    output.push(`<${tag}>${items.join('')}</${tag}>`)
  }
  return output.join('')
}

const chapterHeadingPattern = /^\s*第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节]\s*[:：、.．—-]?\s*(.*)$/u
const volumeHeadingPattern = /^(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[卷部篇册集]|[卷部篇册集]\s*[0-9零〇一二两三四五六七八九十百千万]+)/u

function inlineText(inlines: Inline[] | undefined) {
  return (inlines || []).map(inline => inline.text || inline.alt || '').join('')
}

function tableText(table: Table): string {
  return table.rows.map(row => row.cells.map(cell => {
    const nested = (cell.tables || []).map(tableText).join('\n')
    return [inlineText(cell.inlines), nested].filter(Boolean).join('\n')
  }).join('\t')).join('\n')
}

function blockText(block: Block) {
  if (block.kind === 'table' && block.table) return tableText(block.table)
  if (block.kind === 'figure') {
    return [
      inlineText(block.figure?.images),
      inlineText(block.figure?.caption)
    ].filter(Boolean).join('\n')
  }
  return inlineText(block.inlines)
}

function blocksText(blocks: Block[]) {
  return blocks.map(blockText).map(value => value.trim()).filter(Boolean).join('\n\n')
}

function normalizeHeading(value: string) {
  return value.replace(/\s+/gu, '').trim()
}

function parseChapterHeading(value: string) {
  const match = value.match(chapterHeadingPattern)
  if (!match) return null
  return {
    label: match[1],
    title: match[2].replace(/\s+/gu, ' ').trim() || value.replace(/\s+/gu, ' ').trim()
  }
}

function isVolumeTitle(value: string) {
  return volumeHeadingPattern.test(value.replace(/\s+/gu, ' ').trim())
}

function firstChapterHeading(blocks: Block[]) {
  for (const block of blocks) {
    if (block.kind !== 'heading') continue
    const heading = parseChapterHeading(blockText(block))
    if (heading) return heading
  }
  return null
}

function stripContentPrefix(blocks: Block[], sourceTitle: string, chapterHeading: ReturnType<typeof parseChapterHeading>) {
  const target = normalizeHeading(sourceTitle)
  const headingIndex = blocks.findIndex(block => {
    if (block.kind !== 'heading') return false
    const text = blockText(block)
    if (chapterHeading && parseChapterHeading(text)) return true
    return normalizeHeading(text) === target
  })
  return headingIndex >= 0 ? blocks.slice(headingIndex + 1) : blocks
}

function volumeMap(items: TOCItem[], parentLabel = '', output = new Map<string, string>()) {
  for (const item of items) {
    const href = item.href.split('#')[0]
    const volume = item.children.length && isVolumeTitle(item.label) ? item.label : parentLabel
    if (href && volume) output.set(href, volume)
    if (item.children.length) volumeMap(item.children, volume, output)
  }
  return output
}

function chapterTitleMap(items: TOCItem[], output = new Map<string, string>()) {
  for (const item of items) {
    const href = item.href.split('#')[0]
    if (href && item.label) output.set(href, item.label)
    if (item.children.length) chapterTitleMap(item.children, output)
  }
  return output
}

export function inferEpubDescription(chapters: ParsedChapter[]) {
  const intro = chapters.find(chapter => {
    if (chapter.kind !== 'frontmatter' || !chapter.contentText.trim()) return false
    const title = normalizeHeading(chapter.title)
    return ['内容简介', '内容提要', '内容介绍', '简介', '作品简介'].includes(title)
  })
  return intro?.contentText.trim().slice(0, 600) || ''
}

export function parseEpubBuffer(buffer: ArrayBuffer, filename: string, onProgress: ProgressListener = () => {}): ParseResult {
  onProgress({ type: 'progress', progress: 8, message: '正在读取 EPUB 容器' })
  const book = parse(new Uint8Array(buffer), { blockAttributes: false })
  const sourceChapters = book.toc.length
    ? book.chapters({ granularity: 'toc', titleSource: 'auto' })
    : book.chapters({ granularity: 'spine', titleSource: 'auto' })
  if (!sourceChapters.length) throw new Error('EPUB 中没有可阅读的章节')

  onProgress({ type: 'progress', progress: 24, message: `正在整理 ${sourceChapters.length} 个章节` })
  const imageCache = new Map<string, string>()
  const volumes = volumeMap(book.toc)
  const chapterTitles = chapterTitleMap(book.toc)
  let seenNumberedChapter = false
  const chapters: ParsedChapter[] = sourceChapters.map((chapter, index) => {
    const blocks = book.blocksInRange(chapter.start, chapter.end)
    if (index % 25 === 0 || index === sourceChapters.length - 1) {
      const progress = 24 + Math.round(((index + 1) / sourceChapters.length) * 66)
      onProgress({ type: 'progress', progress, message: `正在解析章节 ${index + 1} / ${sourceChapters.length}` })
    }
    const href = chapter.href.split('#')[0]
    const sourceTitle = (chapterTitles.get(href) || chapter.title || '').replace(/\s+/gu, ' ').trim()
    const chapterHeading = parseChapterHeading(sourceTitle) || firstChapterHeading(blocks)
    const mappedVolume = volumes.get(href) || ''
    let kind: ChapterKind
    if (chapterHeading) {
      kind = 'chapter'
      seenNumberedChapter = true
    } else if (isVolumeTitle(sourceTitle)) {
      kind = 'volume'
    } else if (mappedVolume && normalizeHeading(sourceTitle) === normalizeHeading(mappedVolume)) {
      kind = 'volume'
    } else if (mappedVolume) {
      // A TOC item nested under a volume is normally a正文 entry even when
      // the source heading omits the conventional “第 X 章” label.
      kind = 'chapter'
      seenNumberedChapter = true
    } else if (!seenNumberedChapter && !mappedVolume) {
      kind = 'frontmatter'
    } else {
      kind = 'appendix'
    }
    const contentBlocks = stripContentPrefix(blocks, sourceTitle, chapterHeading)
    const contentText = blocksText(contentBlocks)
    return {
      number: index + 1,
      originalLabel: chapterHeading?.label || sourceTitle || String(index + 1),
      title: chapterHeading?.title || sourceTitle || '未命名内容',
      volume: kind === 'frontmatter' ? '前置内容' : !mappedVolume && kind === 'appendix' ? '附加内容' : mappedVolume,
      kind,
      content: blocksHtml(contentBlocks, book, imageCache),
      contentText,
      contentFormat: 'html',
      wordCount: contentText.replace(/\s/g, '').length
    }
  })

  onProgress({ type: 'progress', progress: 94, message: '正在整理封面和书籍信息' })
  const cover = book.cover()
  const coverDataUrl = cover
    ? `data:${cover.contentType};base64,${bytesToBase64(cover.bytes)}`
    : undefined
  const warnings: string[] = []
  if (!book.toc.length) warnings.push('EPUB 未提供目录，已按书脊顺序生成章节。')
  if (book.warnings.length) warnings.push(`解析器已兼容处理 ${book.warnings.length} 处 EPUB 格式问题。`)

  return {
    metadata: {
      title: book.metadata.title?.trim() || filename.replace(/\.epub$/i, ''),
      author: book.metadata.authors.join('、'),
      description: book.metadata.descriptions[0]?.value?.trim() || inferEpubDescription(chapters),
      encoding: 'utf-8',
      sourceName: filename,
      sourceSize: buffer.byteLength,
      sourceFormat: 'epub',
      coverDataUrl
    },
    chapters,
    warnings
  }
}
