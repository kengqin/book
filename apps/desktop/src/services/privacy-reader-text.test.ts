// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildPrivacyReaderText } from './privacy-reader-text'

describe('privacy reader text formatting', () => {
  it('gives short EPUB paragraphs the same two-character indent as other paragraphs', () => {
    const text = buildPrivacyReaderText(
      '<p>“前辈！”</p><p>“快逃！！”</p><p>啊——</p><p>普通正文。</p><h2>章节标题</h2><ul><li>条目</li></ul>',
      'html'
    )

    expect(text).toBe([
      '　　“前辈！”',
      '　　“快逃！！”',
      '　　啊——',
      '　　普通正文。',
      '章节标题',
      '· 条目'
    ].join('\n'))
  })

  it('normalizes plain-text paragraphs to one two-character indent', () => {
    expect(buildPrivacyReaderText('　原有缩进\n换行\n\n短句', 'text')).toBe('　　原有缩进换行\n　　短句')
  })
})
