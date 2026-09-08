// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { normalizeParagraphStart, prepareReaderParagraphs } from './reader-paragraphs'
import { normalizeReaderWidth, readerWidths } from './reader-appearance'

describe('reader paragraph indentation', () => {
  it('removes existing indentation without changing internal spacing', () => {
    expect(normalizeParagraphStart(' \t\u3000\u3000正文 中间 空格')).toBe('正文 中间 空格')
    expect(normalizeParagraphStart('正文')).toBe('正文')
  })
  it('normalizes rich paragraphs across nested inline elements', () => {
    const html = prepareReaderParagraphs('<p>　 <span>　 </span><strong>　正文</strong> 内容</p>')
    expect(html).toBe('<p class="reader-body-paragraph"><span></span><strong>正文</strong> 内容</p>')
    expect(prepareReaderParagraphs(html)).toBe(html)
  })
  it('leaves headings and special layouts alone', () => {
    const html = '<h2>　标题</h2><ul><li><p>　列表</p></li></ul><pre>  code</pre><blockquote><p>　引用</p></blockquote><p><img src="cover.png"></p><p>　</p>'
    expect(prepareReaderParagraphs(html)).toBe(html)
  })
})

describe('reader page widths', () => {
  it('restores all supported widths', () => {
    for (const width of readerWidths) expect(normalizeReaderWidth(width)).toBe(width)
  })
  it('defaults to 800 for missing or invalid saved values', () => {
    for (const width of [undefined, null, '800', -1, 0, 9999, {}]) expect(normalizeReaderWidth(width)).toBe(800)
  })
})
