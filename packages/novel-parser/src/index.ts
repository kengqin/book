import type { ParseOptions, ParsedChapter, ParserRequest, ParserResponse, ParseResult, TextEncoding } from '@novel-library/reader-core'

const chineseNumberPattern = '零〇一二两三四五六七八九十百千万两'
const volumePattern = new RegExp(`^第\\s*([0-9]{1,4}|[${chineseNumberPattern}]+)\\s*卷[\\s　]*(.*)$`, 'u')
const sectionDividerPattern = /^[=＝_*—-]{4,}$/u
const terminalPattern = /[。！？!?；;：:“”’》）】…]$/u
const leadingPunctuation = /^[，。！？；：、）》”’…]/u

export type ParseProgress = Extract<ParserResponse, { type: 'progress' }>
export type ParseProgressListener = (progress: ParseProgress) => void

export function detectEncoding(buffer: ArrayBuffer, requested: TextEncoding): Exclude<TextEncoding, 'auto'> {
  if (requested !== 'auto') return requested
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return 'utf-8'
  } catch {
    return 'gb18030'
  }
}

function parseHeading(line: string, customPattern: RegExp | undefined) {
  if (customPattern) {
    const match = line.match(customPattern)
    if (match) return { label: match[1] || '章节', title: match[2]?.trim() || match[1] || '未命名章节' }
  }
  const separator = '[\\s　:：、.．—-]+'
  const numbered = line.match(new RegExp(`^第\\s*([0-9]{1,5}|[${chineseNumberPattern}]+)\\s*[章回节](?:${separator}(.{1,80}))?$`, 'u'))
  if (numbered) return { label: numbered[1], title: numbered[2]?.trim() || `第${numbered[1]}章` }
  const special = line.match(new RegExp(`^(序章|楔子|引子|后记|尾声)(?:${separator}(.{1,80}))?$`, 'u'))
  if (special) return { label: special[1], title: special[2]?.trim() || special[1] }
  const extra = line.match(new RegExp(`^(番外(?:篇)?[0-9${chineseNumberPattern}]*)(?:${separator}(.{1,80}))?$`, 'u'))
  if (extra) return { label: extra[1], title: extra[2]?.trim() || extra[1] }
  const finale = line.match(new RegExp(`^((?:收官章|终章)[0-9${chineseNumberPattern}]*|大结局)(?:${separator}(.{1,80}))?$`, 'u'))
  if (finale) return { label: finale[1], title: finale[2]?.trim() || finale[1] }
  return null
}

function cleanBody(lines: string[], options: ParseOptions, adPatterns: RegExp[]) {
  const paragraphs: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/^[\t 　]+/u, '').trimEnd()
    if (!line || volumePattern.test(line)) continue
    if (options.removeAds && adPatterns.some(pattern => pattern.test(line))) continue
    const previous = paragraphs.at(-1)
    if (previous && (leadingPunctuation.test(line) || (options.mergeWrapped && !terminalPattern.test(previous)))) {
      paragraphs[paragraphs.length - 1] += line
    } else {
      paragraphs.push(line)
    }
  }
  return paragraphs.join('\n\n').trim()
}

export function parseNovel(request: ParserRequest, onProgress: ParseProgressListener = () => {}): ParseResult {
  onProgress({ type: 'progress', progress: 8, message: '正在识别文本编码' })
  const encoding = detectEncoding(request.buffer, request.options.encoding)
  const text = new TextDecoder(encoding).decode(request.buffer).replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const headerLines = lines.slice(0, 160).map(line => line.trim())
  const nonEmptyHeaderLines = headerLines.filter(Boolean)
  const sourceTitle = request.filename.replace(/\.(txt|text)$/i, '').trim()
  const title = nonEmptyHeaderLines.map(line => line.match(/《([^》]{1,80})》/u)?.[1]).find(Boolean) || sourceTitle
  const author = nonEmptyHeaderLines.map(line => line.match(/^(?:作者|作 者)[：:]\s*(.+)$/u)?.[1]?.trim()).find(Boolean) || ''
  const introIndex = headerLines.findIndex(line => /^(内容简介|简介)[：:]?$/u.test(line))
  const descriptionLines: string[] = []
  if (introIndex >= 0) {
    for (const line of headerLines.slice(introIndex + 1)) {
      if (sectionDividerPattern.test(line) || volumePattern.test(line) || parseHeading(line, undefined)) break
      if (!line) {
        if (descriptionLines.length) break
        continue
      }
      descriptionLines.push(line)
      if (descriptionLines.length >= 7) break
    }
  }
  const description = descriptionLines.join('\n').slice(0, 600)

  let customPattern: RegExp | undefined
  if (request.options.chapterPattern.trim()) customPattern = new RegExp(request.options.chapterPattern.trim(), 'u')
  const adPatterns = request.options.adPatterns.split('\n').map(item => item.trim()).filter(Boolean).map(pattern => new RegExp(pattern, 'u'))
  const headers: Array<{ line: number; label: string; title: string; volume: string }> = []
  let volume = ''

  onProgress({ type: 'progress', progress: 28, message: '正在识别卷与章节' })
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    const volumeMatch = line.match(volumePattern)
    if (volumeMatch) {
      volume = volumeMatch[2]?.trim() ? `第${volumeMatch[1]}卷 ${volumeMatch[2].trim()}` : `第${volumeMatch[1]}卷`
      return
    }
    const heading = parseHeading(line, customPattern)
    if (heading) headers.push({ line: index, ...heading, volume })
  })

  const warnings: string[] = []
  if (!headers.length) {
    warnings.push('未检测到章节标题，已将全文作为单章导入。可填写自定义章节正则后重新解析。')
    headers.push({ line: -1, label: '正文', title: '正文', volume: '' })
  }

  onProgress({ type: 'progress', progress: 52, message: `正在整理 ${headers.length} 个章节` })
  const chapters: ParsedChapter[] = headers.map((header, index) => {
    const start = header.line + 1
    const end = headers[index + 1]?.line ?? lines.length
    const content = cleanBody(lines.slice(start, end), request.options, adPatterns)
    return {
      number: index + 1,
      originalLabel: header.label,
      title: header.title,
      volume: header.volume,
      content,
      wordCount: content.replace(/\s/g, '').length
    }
  })

  const empty = chapters.filter(chapter => !chapter.content).length
  const short = chapters.filter(chapter => chapter.wordCount > 0 && chapter.wordCount < 100).length
  if (empty) warnings.push(`有 ${empty} 章没有正文，请检查章节规则。`)
  if (short) warnings.push(`有 ${short} 章少于 100 字，可能存在误拆分。`)
  onProgress({ type: 'progress', progress: 92, message: '正在生成预览' })

  return {
    metadata: { title, author, description, encoding, sourceName: request.filename, sourceSize: request.buffer.byteLength },
    chapters,
    warnings
  }
}
