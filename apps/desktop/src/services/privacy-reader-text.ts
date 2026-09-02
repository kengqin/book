const PARAGRAPH_INDENT = '　　'
const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, blockquote, li, figcaption, pre, td, th'

function indentParagraph(text: string) {
  return `${PARAGRAPH_INDENT}${text}`
}

export function buildPrivacyReaderText(content: string, contentFormat: 'text' | 'html') {
  if (contentFormat !== 'html') {
    return content
      .split(/\n{2,}/u)
      .map(paragraph => paragraph.replace(/\s*\n\s*/gu, '').trim())
      .filter(Boolean)
      .map(indentParagraph)
      .join('\n')
  }

  const document = new DOMParser().parseFromString(content, 'text/html')
  return Array.from(document.body.querySelectorAll(BLOCK_SELECTOR))
    .filter(element => !element.querySelector(BLOCK_SELECTOR))
    .map(element => {
      const text = (element.textContent || '').replace(/\s+/gu, ' ').trim()
      if (!text) return ''
      if (element.tagName === 'LI') return `· ${text}`
      if (/^H[1-6]$/u.test(element.tagName)) return text
      if (element.tagName === 'P' || element.tagName === 'BLOCKQUOTE') return indentParagraph(text)
      return text
    })
    .filter(Boolean)
    .join('\n')
}
