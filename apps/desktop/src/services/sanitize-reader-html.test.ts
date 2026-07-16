// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeReaderHtml } from './sanitize-reader-html'

describe('reader HTML sanitizer', () => {
  it('keeps EPUB layout while removing executable backup content', () => {
    const html = sanitizeReaderHtml(`
      <h2 style="position:fixed">标题</h2>
      <p onclick="alert(1)">正文 <a href="#note">脚注</a></p>
      <img src="data:image/png;base64,AA==" onerror="alert(2)">
      <table><tr><td colspan="2">表格</td></tr></table>
      <iframe src="https://example.com"></iframe><script>alert(3)</script>
    `)

    expect(html).toContain('<h2>标题</h2>')
    expect(html).toContain('href="#note"')
    expect(html).toContain('data:image/png;base64,AA==')
    expect(html).toContain('<table>')
    expect(html).not.toMatch(/script|iframe|onclick|onerror|style=/i)
  })

  it('blocks javascript links', () => {
    expect(sanitizeReaderHtml('<a href="javascript:alert(1)">危险链接</a>')).toBe('<a>危险链接</a>')
  })
})
