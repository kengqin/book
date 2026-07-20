// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeReaderHtml } from './sanitize-reader-html'

describe('mobile EPUB HTML sanitizer', () => {
  it('keeps safe typography and removes executable or unsafe CSS', () => {
    const html = sanitizeReaderHtml('<h2 style="font-size: 22px; color: #234; position: fixed">标题</h2><p onclick="alert(1)">正文</p><script>alert(2)</script><img src="data:image/png;base64,AA==" onerror="alert(3)">')
    expect(html).toContain('font-size: 22px')
    expect(html).toContain('color: #234')
    expect(html).not.toMatch(/position|script|onclick|onerror/i)
    expect(html).toContain('data:image/png;base64,AA==')
  })
})
